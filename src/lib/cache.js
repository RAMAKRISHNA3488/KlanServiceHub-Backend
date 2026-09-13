import crypto from 'crypto';
import { createMiddleware } from 'hono/factory';

// In-Memory Cache Store with TTL, ETag, and Tag-based Invalidation
class MemoryCacheStore {
  constructor(maxEntries = 1000) {
    this.store = new Map();
    this.tagMap = new Map(); // tag -> Set of keys
    this.maxEntries = maxEntries;
  }

  // Generate SHA-1 ETag from content
  static generateETag(content) {
    const str = typeof content === 'string' ? content : JSON.stringify(content);
    return `W/"${crypto.createHash('sha1').update(str).digest('hex')}"`;
  }

  get(key) {
    const entry = this.store.get(key);
    if (!entry) return null;

    if (Date.now() > entry.expiresAt) {
      this.delete(key);
      return null;
    }

    return entry;
  }

  set(key, value, { ttlSeconds = 60, tags = [], contentType = 'application/json' } = {}) {
    // Evict oldest if full
    if (this.store.size >= this.maxEntries) {
      const firstKey = this.store.keys().next().value;
      if (firstKey) this.delete(firstKey);
    }

    const etag = MemoryCacheStore.generateETag(value);
    const expiresAt = Date.now() + ttlSeconds * 1000;

    const entry = {
      value,
      etag,
      contentType,
      expiresAt,
      tags: new Set(tags),
    };

    this.store.set(key, entry);

    // Index tags
    for (const tag of tags) {
      if (!this.tagMap.has(tag)) {
        this.tagMap.set(tag, new Set());
      }
      this.tagMap.get(tag).add(key);
    }

    return entry;
  }

  delete(key) {
    const entry = this.store.get(key);
    if (!entry) return false;

    // Clean up tag indices
    for (const tag of entry.tags) {
      const keySet = this.tagMap.get(tag);
      if (keySet) {
        keySet.delete(key);
        if (keySet.size === 0) {
          this.tagMap.delete(tag);
        }
      }
    }

    return this.store.delete(key);
  }

  // Invalidate all cache entries associated with one or more tags
  invalidateTags(...tags) {
    let invalidatedCount = 0;
    const flatTags = tags.flat();

    for (const tag of flatTags) {
      const keys = this.tagMap.get(tag);
      if (keys) {
        for (const key of Array.from(keys)) {
          if (this.delete(key)) {
            invalidatedCount++;
          }
        }
        this.tagMap.delete(tag);
      }
    }

    return invalidatedCount;
  }

  // Clear everything
  clear() {
    this.store.clear();
    this.tagMap.clear();
  }

  getStats() {
    return {
      size: this.store.size,
      maxEntries: this.maxEntries,
      trackedTags: this.tagMap.size,
    };
  }
}

export const cacheStore = new MemoryCacheStore(2000);

/**
 * Determine cache tags from request URL path
 */
export const extractResourceTagsFromUrl = (pathname) => {
  const segments = pathname.split('/').filter(Boolean);
  const tags = [];

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (['api', 'v1'].includes(seg)) continue;

    tags.push(seg);
    if (i + 1 < segments.length && !['api', 'v1'].includes(segments[i + 1])) {
      tags.push(`${seg}:${segments[i + 1]}`);
    }
  }

  return tags;
};

/**
 * Hono Middleware for Caching & Cache Validation (ETag / If-None-Match / 304)
 */
export const cacheMiddleware = ({ ttlSeconds = 60, tags = [] } = {}) => {
  return createMiddleware(async (ctx, next) => {
    // Only cache GET or HEAD requests
    if (ctx.req.method !== 'GET' && ctx.req.method !== 'HEAD') {
      return next();
    }

    // Build unique cache key taking auth cookie or authorization header into account
    const url = ctx.req.url;
    const user = ctx.get('user');
    const userId = user?.id || user?.$id || 'anonymous';
    const cacheKey = `${userId}:${url}`;

    // Compute tags (custom tags + path-based tags)
    const urlPath = new URL(url, 'http://localhost').pathname;
    const computedTags = Array.from(new Set([...tags, ...extractResourceTagsFromUrl(urlPath)]));

    // Check existing cache
    const cached = cacheStore.get(cacheKey);
    const clientETag = ctx.req.header('if-none-match');

    if (cached) {
      // Validate ETag
      if (clientETag && (clientETag === cached.etag || clientETag === `W/${cached.etag}` || clientETag.includes(cached.etag))) {
        ctx.header('ETag', cached.etag);
        ctx.header('Cache-Control', 'private, no-cache, must-revalidate');
        ctx.header('X-Cache-Status', 'HIT-REVALIDATED');
        return ctx.body(null, 304);
      }

      ctx.header('ETag', cached.etag);
      ctx.header('Cache-Control', 'private, no-cache, must-revalidate');
      ctx.header('X-Cache-Status', 'HIT');

      if (cached.contentType.includes('application/json')) {
        return ctx.json(cached.value);
      }
      return ctx.text(cached.value);
    }

    // Cache MISS: Proceed with request
    await next();

    // Cache successful 200 responses
    if (ctx.res.status === 200) {
      try {
        const clonedRes = ctx.res.clone();
        const contentType = clonedRes.headers.get('content-type') || 'application/json';

        let bodyData;
        if (contentType.includes('application/json')) {
          bodyData = await clonedRes.json();
        } else {
          bodyData = await clonedRes.text();
        }

        const entry = cacheStore.set(cacheKey, bodyData, {
          ttlSeconds,
          tags: computedTags,
          contentType,
        });

        ctx.header('ETag', entry.etag);
        ctx.header('Cache-Control', 'private, no-cache, must-revalidate');
        ctx.header('X-Cache-Status', 'MISS');
      } catch (err) {
        // Silently continue if response cloning or parsing fails
      }
    }
  });
};

/**
 * Middleware that automatically invalidates related cache tags on mutating requests (POST, PUT, PATCH, DELETE)
 */
export const autoInvalidateCacheMiddleware = () => {
  return createMiddleware(async (ctx, next) => {
    const method = ctx.req.method;
    const isMutating = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);

    await next();

    // If mutation was successful (2xx or 3xx), invalidate corresponding cache tags
    if (isMutating && ctx.res.status >= 200 && ctx.res.status < 400) {
      const urlPath = new URL(ctx.req.url, 'http://localhost').pathname;
      const tagsToInvalidate = extractResourceTagsFromUrl(urlPath);

      if (tagsToInvalidate.length > 0) {
        cacheStore.invalidateTags(tagsToInvalidate);
        if (tagsToInvalidate.some(t => t.includes('tasks') || t.includes('projects') || t.includes('workspaces') || t.includes('sprints'))) {
          cacheStore.invalidateTags('reports', 'analytics', 'dashboards', 'roadmap');
        }
      }
    }
  });
};
