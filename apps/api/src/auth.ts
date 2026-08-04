import { UnauthorizedException } from "@nestjs/common";

export function requireMutationToken(authorization?: string): void {
  const configured = process.env.ARF_API_TOKEN;
  if (!configured) {
    throw new UnauthorizedException(
      "Mutation API is disabled until ARF_API_TOKEN is set"
    );
  }
  if (authorization !== `Bearer ${configured}`) {
    throw new UnauthorizedException("A valid bearer token is required");
  }
}
