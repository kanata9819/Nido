import type { NidoAPI } from '../shared/types'
declare global {
  interface Window {
    nido: NidoAPI
  }
}
