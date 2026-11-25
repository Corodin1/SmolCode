import type { SmolCodeApi } from './shared/types';

declare global {
  interface Window {
    smolcode: SmolCodeApi;
  }
}
