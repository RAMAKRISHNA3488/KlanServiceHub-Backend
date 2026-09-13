/**
 * Standardized Enterprise Exception Classes & Error Formatting (RFC 7807)
 */

export class AppError extends Error {
  constructor(message, statusCode = 400, code = 'BAD_REQUEST', details = null) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    Error.captureStackTrace(this, this.constructor);
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Validation failed', details = null) {
    super(message, 422, 'VALIDATION_ERROR', details);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required') {
    super(message, 401, 'UNAUTHORIZED');
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'You do not have permission to perform this action') {
    super(message, 403, 'FORBIDDEN');
  }
}

export class NotFoundError extends AppError {
  constructor(resource = 'Resource') {
    super(`${resource} not found`, 404, 'NOT_FOUND');
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Resource already exists') {
    super(message, 409, 'CONFLICT');
  }
}

export class RateLimitError extends AppError {
  constructor(message = 'Too many requests. Please try again later.') {
    super(message, 429, 'RATE_LIMIT_EXCEEDED');
  }
}

/**
 * Format standard error JSON response payload
 */
export function formatErrorResponse(err, req) {
  const isDev = process.env.NODE_ENV !== 'production';
  const statusCode = err.statusCode || (err.status >= 400 && err.status < 600 ? err.status : 500);
  const code = err.code || (statusCode === 404 ? 'NOT_FOUND' : statusCode === 401 ? 'UNAUTHORIZED' : statusCode === 403 ? 'FORBIDDEN' : statusCode === 422 ? 'VALIDATION_ERROR' : 'INTERNAL_SERVER_ERROR');

  return {
    success: false,
    error: err.message || 'An unexpected error occurred',
    code,
    statusCode,
    path: req?.url ? new URL(req.url).pathname : undefined,
    method: req?.method,
    timestamp: new Date().toISOString(),
    details: err.details || undefined,
    ...(isDev && err.stack ? { stack: err.stack } : {}),
  };
}
