import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { isIpInCidr } from "../http/ip-address";

function isAllowedIp(ip: string, cidr: string): boolean {
  return ip === cidr || isIpInCidr(ip, cidr);
}

@Injectable()
export class ApiKeyAllowlistGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const apiKey = request['apiKey']; // Populated by prior Auth Guard
    if (!apiKey || !apiKey.allowlistCidrs || apiKey.allowlistCidrs.length === 0) {
      return true; // Empty allowlist preserves default behavior
    }

    const clientIp = request.ip;
    if (!clientIp) {
      throw new ForbiddenException('Unable to resolve client IP address');
    }

    const isAllowed = apiKey.allowlistCidrs.some((cidr: string) =>
      isAllowedIp(clientIp, cidr),
    );

    if (!isAllowed) {
      throw new ForbiddenException(`IP address ${clientIp} is not authorized`);
    }

    return true;
  }
}
