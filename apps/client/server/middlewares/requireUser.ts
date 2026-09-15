import { NextFunction, Request, Response } from 'express';

export const requireUser = (req: Request, res: Response, next: NextFunction) => {
  if (!req.user) {
    return res.status(401).json({ message: 'Unauthorized', request_id: req.requestId });
  }

  next();
};
