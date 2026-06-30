// NextAuth type augmentation
import "next-auth";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      email: string;
      role: string;
      status: string;
      studentId: number | null;
      program: string | null;
      section: string | null;
      fullName: string;
    };
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id?: string;
    role?: string;
    status?: string;
    studentId?: number | null;
    program?: string | null;
    section?: string | null;
    fullName?: string;
    authProvider?: string;
  }
}
