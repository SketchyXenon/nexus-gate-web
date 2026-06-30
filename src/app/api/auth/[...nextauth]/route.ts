import NextAuth, { type NextAuthOptions } from "next-auth";
import GoogleProvider from "next-auth/providers/google";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";

// ====================================================================
// Nexus Gate - NextAuth Configuration (Google OAuth)
//
// Flow:
//   1. User clicks "Sign in with Google"
//   2. Google verifies their identity and returns email + name
//   3. We check if their email exists as an account
//   4. If yes -> link OAuth provider and sign in
//   5. If no -> check whitelist, or auto-create a basic account
//      (Google has verified the email, so we trust it)
// ====================================================================

export const authOptions: NextAuthOptions = {
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID || "",
      clientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
    }),
  ],
  session: {
    strategy: "jwt",
    maxAge: 7 * 24 * 60 * 60,
  },
  pages: {
    signIn: "/",
    error: "/",
  },
  callbacks: {
    async signIn({ user, account }) {
      if (!user?.email) return false;
      const email = user.email.toLowerCase().trim();

      try {
        // Check if account already exists
        const existing = await db.account.findUnique({ where: { email } });

        if (existing) {
          if (existing.status === "SUSPENDED") return false;
          if (!existing.authProvider) {
            await db.account.update({
              where: { id: existing.id },
              data: {
                authProvider: account?.provider ?? "google",
                providerAccountId: account?.providerAccountId ?? null,
                ...(existing.status === "PENDING_VERIFICATION"
                  ? { status: "ACTIVE" }
                  : {}),
              },
            });
          }
          return true;
        }

        // No existing account - check whitelist
        const student = await db.authorizedStudent.findUnique({
          where: { email },
        });

        if (student) {
          // Whitelisted - create account with student info
          await db.account.create({
            data: {
              email,
              fullName: user.name ?? student.fullName,
              role: "USER",
              status: "ACTIVE",
              studentId: student.studentId,
              program: student.program,
              section: student.section,
              passwordHash: "",
              authProvider: account?.provider ?? "google",
              providerAccountId: account?.providerAccountId ?? null,
              lastLoginAt: new Date(),
            },
          });
          await db.authorizedStudent.update({
            where: { studentId: student.studentId },
            data: { activated: true },
          });
          return true;
        }

        // Not on whitelist - auto-create basic account (Google verified email)
        await db.account.create({
          data: {
            email,
            fullName: user.name ?? "Google User",
            role: "USER",
            status: "ACTIVE",
            passwordHash: "",
            authProvider: account?.provider ?? "google",
            providerAccountId: account?.providerAccountId ?? null,
            lastLoginAt: new Date(),
          },
        });
        return true;
      } catch (error) {
        console.error("[nextauth] signIn callback error:", error);
        // If it's a unique constraint violation, the account was already
        // created (possibly by a concurrent request). Try to find it.
        if (
          error instanceof Error &&
          error.message.includes("Unique constraint")
        ) {
          const retry = await db.account.findUnique({ where: { email } });
          if (retry && retry.status !== "SUSPENDED") return true;
        }
        return false;
      }
    },

    async jwt({ token, user }) {
      if (user?.email) {
        try {
          const dbAccount = await db.account.findUnique({
            where: { email: user.email.toLowerCase() },
            select: {
              id: true,
              role: true,
              status: true,
              studentId: true,
              program: true,
              section: true,
              fullName: true,
            },
          });
          if (dbAccount) {
            token.id = dbAccount.id;
            token.role = dbAccount.role;
            token.status = dbAccount.status;
            token.studentId = dbAccount.studentId;
            token.program = dbAccount.program;
            token.section = dbAccount.section;
            token.fullName = dbAccount.fullName;
          }
        } catch (error) {
          console.error("[nextauth] jwt callback error:", error);
        }
      }
      return token;
    },

    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.id as string;
        session.user.role = token.role as string;
        session.user.status = token.status as string;
        session.user.studentId = token.studentId as number | null;
        session.user.program = token.program as string | null;
        session.user.section = token.section as string | null;
        session.user.fullName = token.fullName as string;
      }
      return session;
    },
  },
  events: {
    async signIn(message) {
      try {
        const email = (message.user?.email ?? "").toLowerCase();
        const acct = await db.account.findUnique({ where: { email } });
        if (acct) {
          await audit({
            actorId: acct.id,
            action: "auth.google_login",
            targetType: "Account",
            targetId: acct.id,
          });
        }
      } catch {
        // Non-critical
      }
    },
  },
  secret: process.env.NEXTAUTH_SECRET,
};

const handler = NextAuth(authOptions);
export { handler as GET, handler as POST };
