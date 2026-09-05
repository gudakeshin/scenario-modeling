export type Role = "viewer" | "analyst" | "approver" | "admin";

export interface AuthUser {
  userId: string;
  email: string;
  name: string | null;
  role: Role;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface RegisterInput {
  email: string;
  password: string;
  name?: string;
}

export interface LoginInput {
  email: string;
  password: string;
}

export interface AuthProvider {
  readonly name: string;
  register(input: RegisterInput): Promise<AuthUser>;
  /** Optional admin-gated registration (local provider). */
  registerByAdmin?(input: RegisterInput & { role?: Role }, admin: AuthUser): Promise<AuthUser>;
  login(
    input: LoginInput,
    meta?: { userAgent?: string; ip?: string },
  ): Promise<{ user: AuthUser; tokens: TokenPair }>;
  refresh(refreshToken: string, meta?: { userAgent?: string; ip?: string }): Promise<TokenPair>;
  logout(refreshToken: string): Promise<void>;
  verifyAccessToken(token: string): Promise<AuthUser>;
}
