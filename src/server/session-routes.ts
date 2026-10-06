import express from 'express';
import type { Account } from './accounts.js';
import type { SessionManager } from './session-manager.js';

export type Ctx = { manager: SessionManager; dir: string; account?: Account };

const ctxOf = (res: express.Response) => res.locals.ctx as Ctx;

export function firstString(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && typeof v[0] === 'string') return v[0];
  return undefined;
}

/** The conversation routes under /api: list, history, rename, delete. Expects
 *  `res.locals.ctx` (who is asking) and a JSON body parser in front. */
export function sessionRoutes(): express.Router {
  const r = express.Router();

  r.get('/sessions', async (req, res, next) => {
    try {
      // A scoped token (/stamp) lists its scope alone, whatever the page asks;
      // any other lists a project's, or every conversation not in a scope.
      const { manager, account } = ctxOf(res);
      res.json(await manager.list(account?.scope ? { scope: account.scope } : { project: firstString(req.query.project) }));
    } catch (err) {
      next(err);
    }
  });

  r.get('/sessions/:id/messages', async (req, res, next) => {
    try {
      res.json(await ctxOf(res).manager.history(String(req.params.id)));
    } catch (err) {
      next(err);
    }
  });

  r.patch('/sessions/:id', async (req, res, next) => {
    try {
      const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
      if (!title) {
        res.status(400).json({ error: 'title is required' });
        return;
      }
      await ctxOf(res).manager.rename(String(req.params.id), title);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  r.delete('/sessions/:id', async (req, res, next) => {
    try {
      await ctxOf(res).manager.remove(String(req.params.id));
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  return r;
}
