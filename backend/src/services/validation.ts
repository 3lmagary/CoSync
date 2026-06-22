import { Request, Response, NextFunction } from 'express';

/**
 * Lightweight input validation utilities.
 * Centralises sanitisation + length limits so every endpoint is protected
 * against oversized payloads, control characters, and injection attempts.
 */

export const LIMITS = {
  USERNAME_MIN: 3,
  USERNAME_MAX: 32,
  PASSWORD_MIN: 8,
  PASSWORD_MAX: 128,
  NAME_MIN: 1,
  NAME_MAX: 100,
  TITLE_MIN: 1,
  TITLE_MAX: 200,
  USERNAME_PATTERN: /^[a-zA-Z0-9_.-]+$/,
} as const;

export interface ValidationError {
  field: string;
  message: string;
}

/** Strips control characters (incl. NULL bytes) and trims surrounding whitespace. */
export function sanitizeString(value: unknown): string {
  if (typeof value !== 'string') return '';
  // Remove ASCII control chars (0x00-0x1F and 0x7F) which can be used for injection / log poisoning.
  return value.replace(/[\x00-\x1F\x7F]/g, '').trim();
}

/** Validates a username against length + allowed-characters rules. */
export function validateUsername(value: unknown): ValidationError | null {
  const username = sanitizeString(value);
  if (!username) return { field: 'username', message: 'Username is required' };
  if (username.length < LIMITS.USERNAME_MIN) {
    return { field: 'username', message: `Username must be at least ${LIMITS.USERNAME_MIN} characters` };
  }
  if (username.length > LIMITS.USERNAME_MAX) {
    return { field: 'username', message: `Username must be at most ${LIMITS.USERNAME_MAX} characters` };
  }
  if (!LIMITS.USERNAME_PATTERN.test(username)) {
    return { field: 'username', message: 'Username may only contain letters, numbers, underscores, dots and hyphens' };
  }
  return null;
}

/** Validates a password against minimum-length rules. */
export function validatePassword(value: unknown): ValidationError | null {
  if (typeof value !== 'string' || value.length === 0) {
    return { field: 'password', message: 'Password is required' };
  }
  if (value.length < LIMITS.PASSWORD_MIN) {
    return { field: 'password', message: `Password must be at least ${LIMITS.PASSWORD_MIN} characters` };
  }
  if (value.length > LIMITS.PASSWORD_MAX) {
    return { field: 'password', message: `Password must be at most ${LIMITS.PASSWORD_MAX} characters` };
  }
  return null;
}

/** Validates a workspace or document name/title against length rules. */
export function validateName(value: unknown, field = 'name'): ValidationError | null {
  const name = sanitizeString(value);
  if (!name) return { field, message: `${field} is required` };
  if (name.length > LIMITS.NAME_MAX) {
    return { field, message: `${field} must be at most ${LIMITS.NAME_MAX} characters` };
  }
  return null;
}

export function validateTitle(value: unknown): ValidationError | null {
  const title = sanitizeString(value);
  if (!title) return { field: 'title', message: 'Document title is required' };
  if (title.length > LIMITS.TITLE_MAX) {
    return { field: 'title', message: `Document title must be at most ${LIMITS.TITLE_MAX} characters` };
  }
  return null;
}

/**
 * Sends a 400 with the first validation error in a uniform shape, or proceeds.
 * Usage: `if (respondValidationError(res, validateUsername(req.body.username))) return;`
 */
export function respondValidationError(res: Response, error: ValidationError | null): boolean {
  if (error) {
    res.status(400).json({ error: error.message, field: error.field });
    return true;
  }
  return false;
}
