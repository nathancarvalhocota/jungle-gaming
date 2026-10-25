import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
} from "@nestjs/common";
import { HealthController } from "../health/health.controller.ts";

@Injectable()
export class NoAuthGuard implements CanActivate {
  canActivate(_context: ExecutionContext): boolean {
    return true;
  }
}

@Injectable()
export class HttpAuthGuard implements CanActivate {
  constructor(
    @Inject(NoAuthGuard) private readonly authentication: CanActivate,
  ) {}

  canActivate(context: ExecutionContext) {
    if (context.getClass() === HealthController) {
      return true;
    }
    return this.authentication.canActivate(context);
  }
}
