import { db } from '../db.js';

/**
 * Generate a clean uppercase project key from a project name.
 * Examples:
 * - "Import and export" -> "IE" (or "IMEX")
 * - "Studio Website" -> "SW" (or "STUD")
 * - "Klanvision Project" -> "KP" (or "KLAN")
 * - "E-Commerce Platform" -> "ECOM"
 * - "Mobile App" -> "MA" (or "MOB")
 */
export function generateProjectKey(projectName, existingKeys = []) {
  if (!projectName || typeof projectName !== 'string') return 'PROJ';
  
  const upperExisting = new Set((existingKeys || []).map((k) => (k || '').toUpperCase().trim()));

  // Split name by non-alphanumeric characters
  const words = projectName
    .trim()
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean);

  let candidate = '';

  if (words.length >= 2) {
    // If multiple words: take first letters of each significant word (ignore trivial stop words if 3+ words)
    const filteredWords = words.length > 2 
      ? words.filter((w) => !['and', 'the', 'or', 'of', 'for', 'in', 'on', 'at', 'to', 'a', 'an'].includes(w.toLowerCase()))
      : words;

    const sourceWords = filteredWords.length >= 2 ? filteredWords : words;
    candidate = sourceWords.map((w) => w[0].toUpperCase()).join('').substring(0, 5);

    if (candidate.length < 2) {
      candidate = words[0].substring(0, 3).toUpperCase();
    }
  } else if (words.length === 1) {
    // Single word: take first 3-4 letters
    candidate = words[0].substring(0, 4).toUpperCase();
  } else {
    candidate = 'PRJ';
  }

  // Clean candidate: only uppercase letters and digits
  candidate = candidate.replace(/[^A-Z0-9]/g, '');
  if (!candidate || candidate.length < 2) {
    candidate = (projectName.replace(/[^A-Z0-9]/gi, '').substring(0, 3) || 'PRJ').toUpperCase();
  }

  // Avoid generic 'PROJ' if the project has a distinct name
  if (candidate === 'PROJ' && words.length > 0 && words[0].toLowerCase() !== 'project') {
    candidate = words[0].substring(0, 3).toUpperCase();
  }

  // Ensure candidate is unique among existingKeys
  if (!upperExisting.has(candidate)) {
    return candidate;
  }

  // If already taken, try adding a number suffix: e.g. SW2, SW3
  let counter = 2;
  while (upperExisting.has(`${candidate}${counter}`)) {
    counter++;
  }

  return `${candidate}${counter}`;
}

/**
 * Get next unique task key for a project e.g. "SW-1", "IE-2", "KLAN-101".
 * Guaranteed to be unique across all tasks.
 */
export function getNextTaskKeyForProject(projectId) {
  if (!projectId) return 'TASK-1';

  // 1. Fetch project info
  const project = db.prepare('SELECT id, name, key, workspace_id FROM projects WHERE id = ?').get(projectId);
  if (!project) return 'TASK-1';

  let projKey = (project.key || '').trim().toUpperCase();

  // If project key is missing or 'PROJ', generate and update a unique project key
  if (!projKey || projKey === 'PROJ') {
    const existingProjects = db.prepare('SELECT key FROM projects WHERE workspace_id = ? AND id != ?').all(project.workspace_id, project.id);
    const existingKeys = existingProjects.map((p) => p.key).filter(Boolean);
    projKey = generateProjectKey(project.name, existingKeys);
    try {
      db.prepare('UPDATE projects SET key = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(projKey, projectId);
    } catch (e) {}
  }

  // 2. Fetch all existing task keys in this project
  const taskRows = db.prepare('SELECT key FROM tasks WHERE project_id = ? AND key IS NOT NULL').all(projectId);

  let maxNum = 0;
  const regex = new RegExp(`^${projKey}-(\\d+)$`, 'i');
  const genericRegex = /^[A-Z0-9]+-(\\d+)$/i;

  for (const row of taskRows) {
    if (!row.key) continue;
    const match = row.key.match(regex);
    if (match) {
      const num = parseInt(match[1], 10);
      if (!isNaN(num) && num > maxNum) {
        maxNum = num;
      }
    } else {
      const genMatch = row.key.match(genericRegex);
      if (genMatch) {
        const num = parseInt(genMatch[1], 10);
        if (!isNaN(num) && num > maxNum) {
          maxNum = num;
        }
      }
    }
  }

  // Next number: if maxNum > 0, next is maxNum + 1. Otherwise start at 1 (or 101 if preferred).
  // In Jira, projects typically start from 1: KEY-1, KEY-2...
  let nextNum = maxNum > 0 ? maxNum + 1 : 1;
  let candidateKey = `${projKey}-${nextNum}`;

  // Double check collision across database just in case
  while (db.prepare('SELECT id FROM tasks WHERE key = ?').get(candidateKey)) {
    nextNum++;
    candidateKey = `${projKey}-${nextNum}`;
  }

  return candidateKey;
}

/**
 * Migration / backfill to make all project keys unique per workspace
 * and all task keys unique per project.
 */
export function backfillProjectAndTaskKeys() {
  try {
    // Normalize any legacy HIGHEST priority to HIGH
    try {
      db.prepare("UPDATE tasks SET priority = 'HIGH' WHERE priority = 'HIGHEST'").run();
    } catch (e) {}

    const workspaces = db.prepare('SELECT id FROM workspaces').all();

    for (const ws of workspaces) {
      const projects = db.prepare('SELECT id, name, key FROM projects WHERE workspace_id = ? ORDER BY created_at ASC').all(ws.id);
      const usedKeys = new Set();

      for (const proj of projects) {
        let currentKey = (proj.key || '').trim().toUpperCase();

        // If key is empty, 'PROJ', or already used in this workspace, generate a unique one
        if (!currentKey || currentKey === 'PROJ' || usedKeys.has(currentKey)) {
          currentKey = generateProjectKey(proj.name, Array.from(usedKeys));
          db.prepare('UPDATE projects SET key = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(currentKey, proj.id);
        }
        usedKeys.add(currentKey);

        // Now update all tasks in this project so they have unique, sequential keys matching this project
        const tasks = db.prepare('SELECT id, key, created_at FROM tasks WHERE project_id = ? ORDER BY position ASC, created_at ASC, id ASC').all(proj.id);
        const seenTaskKeysInProject = new Set();
        let taskNum = 1;

        for (const task of tasks) {
          const isInvalidKey = !task.key || 
            task.key.startsWith('PROJ-') || 
            !task.key.startsWith(`${currentKey}-`) ||
            seenTaskKeysInProject.has(task.key);

          if (isInvalidKey) {
            let nextKey = `${currentKey}-${taskNum}`;
            while (seenTaskKeysInProject.has(nextKey)) {
              taskNum++;
              nextKey = `${currentKey}-${taskNum}`;
            }
            db.prepare('UPDATE tasks SET key = ? WHERE id = ?').run(nextKey, task.id);
            seenTaskKeysInProject.add(nextKey);
          } else {
            seenTaskKeysInProject.add(task.key);
          }
          taskNum++;
        }
      }
    }
  } catch (err) {
    console.error('[BACKFILL_KEYS_ERROR]:', err);
  }
}
