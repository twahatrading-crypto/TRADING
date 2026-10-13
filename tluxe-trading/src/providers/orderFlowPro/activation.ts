import { IS_CLOUD } from '../../config/deployment';

/* ============================================================================
 * Order Flow Pro data-source activation (website build only). Order Flow Pro-only: no shared config, route or
 * environment variable of the app is involved.
 *
 *   OFP_GATEWAY_RELEASED = false  -> the website keeps the BackendSource guard: BACKEND OFFLINE, no requests.
 *   OFP_GATEWAY_RELEASED = true   -> the website reads the gateway's existing read-only market-data endpoints
 *                                    (GatewaySource). Flipping it is a code change in THIS file, made only in a
 *                                    separately approved release.
 *
 * Test builds only: `VITE_TLUXE_OFP_GATEWAY=1 npm run build:cloud` enables it for that local build. The production
 * Dockerfile declares no build ARG for it, so a Railway variable can never switch it on by accident.
 * Local (non-cloud) builds always use the local backend link (the gateway is same-origin only).
 * ========================================================================== */

export const OFP_GATEWAY_RELEASED = false;

export function gatewaySourceEnabled(cloud: boolean = IS_CLOUD, released: boolean = OFP_GATEWAY_RELEASED, testFlag: unknown = import.meta.env.VITE_TLUXE_OFP_GATEWAY): boolean {
  return cloud && (released || testFlag === '1');
}
