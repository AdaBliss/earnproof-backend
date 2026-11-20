import { SetMetadata } from '@nestjs/common';
import { RouteClassification } from '../cache/route-classification';

export const CACHE_CLASSIFICATION_KEY = 'cache_classification';

export const CacheClassification = (classification: RouteClassification) =>
  SetMetadata(CACHE_CLASSIFICATION_KEY, classification);
