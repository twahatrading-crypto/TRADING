import { createContext, useContext } from 'react';
import type { CloudRuntime } from '../../services/cloud/cloudRuntime';

/** Present only in the cloud build after sign-in (null in local development). */
export const CloudRuntimeContext = createContext<CloudRuntime | null>(null);

export const useCloudRuntime = () => useContext(CloudRuntimeContext);
