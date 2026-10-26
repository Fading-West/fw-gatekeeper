import { ConvexCredentials } from '@convex-dev/auth/providers/ConvexCredentials';
import { convexAuth } from '@convex-dev/auth/server';
import { v } from 'convex/values';
import { Scrypt } from 'lucia';
import { internal } from './_generated/api';
import { internalMutation } from './_generated/server';
import type { Id } from './_generated/dataModel';
import type { MutationCtx } from './_generated/server';

type PasswordSessionResult = 'InvalidAccountId' | 'TooManyFailedAttempts' | 'InvalidSecret'
  | { userId: Id<'users'>; sessionId: Id<'authSessions'> };

// Password's default authorize verifies credentials and creates the session in
// separate transactions. Rotation between them would give an old password a
// session newer than sessionRevokedAt. Bind verification and session creation
// in one transaction, using the library's store for crypto, rate limits and
// session policy. Returning failures preserves the library's failed-attempt
// writes; the action throws only after this mutation commits.
export const authenticatePassword = internalMutation({
  args: { email: v.string(), password: v.string() },
  returns: v.union(
    v.literal('InvalidAccountId'), v.literal('TooManyFailedAttempts'), v.literal('InvalidSecret'),
    v.object({ userId: v.id('users'), sessionId: v.id('authSessions') }),
  ),
  handler: async (ctx, args): Promise<PasswordSessionResult> => {
    const retrieved = await ctx.runMutation(internal.auth.store, { args: {
      type: 'retrieveAccountWithCredentials', provider: 'password',
      account: { id: args.email, secret: args.password },
    } });
    if (retrieved === 'InvalidAccountId' || retrieved === 'TooManyFailedAttempts' || retrieved === 'InvalidSecret') return retrieved;
    if (!retrieved || typeof retrieved !== 'object' || !('account' in retrieved)) throw new Error('Password account lookup failed');
    const session = await ctx.runMutation(internal.auth.store, { args: {
      type: 'signIn', userId: retrieved.account.userId, generateTokens: false,
    } });
    if (!session || typeof session !== 'object' || !('sessionId' in session) || !('userId' in session)) throw new Error('Password session creation failed');
    return { userId: session.userId, sessionId: session.sessionId };
  },
});

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  callbacks: {
    async beforeSessionCreation(ctx, { userId }) {
      const db = ctx.db as MutationCtx['db'];
      const member = await db.query('portalMembers')
        .withIndex('by_user', (q) => q.eq('userId', userId)).unique();
      if (!member?.active) throw new Error('Portal account is disabled');
    },
  },
  providers: [
    ConvexCredentials({
      id: 'password',
      // Exactly the Password provider's default Lucia crypto.
      crypto: {
        hashSecret: password => new Scrypt().hash(password),
        verifySecret: (password, hash) => new Scrypt().verify(hash, password),
      },
      async authorize(params, ctx) {
        const flow = String(params.flow ?? 'signIn');
        if (flow === 'signUp') {
          throw new Error('Portal account creation is invite-only. Ask an administrator for access.');
        }
        if (flow !== 'signIn') throw new Error('Only password sign-in is enabled');

        const email = String(params.email ?? '').trim().toLowerCase();
        if (!email) {
          throw new Error('Email is required');
        }
        if (typeof params.password !== 'string') throw new Error('Password is required');
        const result: PasswordSessionResult = await ctx.runMutation(internal.auth.authenticatePassword, {
          email, password: params.password,
        });
        if (typeof result === 'string') throw new Error(result);
        // Convex Auth issues tokens for this existing session. If rotation
        // intervenes now, this session predates the cutoff and cannot access
        // portal data, even if a JWT is issued afterwards.
        return result;
      },
    }),
  ],
});
