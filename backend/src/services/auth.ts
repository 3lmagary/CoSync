import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { logger } from './logger';

export const JWT_SECRET = process.env.JWT_SECRET || 'sync-platform-super-secret-key-1337';
const TOKEN_EXPIRY = '24h';

export interface UserTokenPayload {
  userId: string;
  username: string;
  color: string;
  exp?: number;
}

export function generateToken(payload: Omit<UserTokenPayload, 'exp'>): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: TOKEN_EXPIRY });
}

export function verifyToken(token: string): UserTokenPayload {
  try {
    return jwt.verify(token, JWT_SECRET) as UserTokenPayload;
  } catch (error) {
    logger.debug('JWT validation failed', { token, error });
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
  try {
    const decoded = verifyToken(token);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid or expired authentication token' });
  }
}
