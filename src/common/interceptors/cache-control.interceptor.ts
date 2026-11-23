import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { RouteClassification } from '../cache/route-classification';
import { computeCacheHeaders } from '../cache/cache-policy';
import { CACHE_CLASSIFICATION_KEY } from '../decorators/cache-classification.decorator';

@Injectable()
export class CacheControlInterceptor implements NestInterceptor {
  constructor(private reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    return next.handle().pipe(
      tap(() => {
        const request = context.switchToHttp().getRequest();
        const response = context.switchToHttp().getResponse();

        const classification =
          this.reflector.get<RouteClassification>(
            CACHE_CLASSIFICATION_KEY,
            context.getHandler()
          ) || RouteClassification.SENSITIVE;

        const method = request.method;
        const status = response.statusCode || 200;
        const existingVary = response.get('Vary');

        const headers = computeCacheHeaders(classification, method, status, existingVary);

        // Set headers
        Object.entries(headers).forEach(([key, value]) => {
          response.set(key, value);
        });

        // Strip validators on sensitive/authenticated
        if (
          classification === RouteClassification.SENSITIVE ||
          classification === RouteClassification.AUTHENTICATED
        ) {
          response.removeHeader('ETag');
          response.removeHeader('Last-Modified');
        }
      })
    );
  }
}
