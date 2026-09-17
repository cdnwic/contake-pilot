/** Dispatcher: live backend M1 when ?api=live (or localStorage contake-api=live), else in-memory mock. */
import * as mock from './mockApi';
import * as live from './liveApi';

const liveMode = new URLSearchParams(location.search).get('api') === 'live' || localStorage.getItem('contake-api') === 'live';
const impl = liveMode ? live : mock;
export const isLive = liveMode;

export const getProfiles = impl.getProfiles;
export const getClientState = impl.getClientState;
export const principalFor = impl.principalFor;
import { isOfflineSim, OfflineError } from './offlineQueue';
export const submitReport: typeof impl.submitReport = (profileId, input, principal) =>
  isOfflineSim() ? Promise.reject(new OfflineError()) : impl.submitReport(profileId, input, principal);
export const saveTask = impl.saveTask;
export const deleteTask = impl.deleteTask;
export const saveDependency = impl.saveDependency;
export const deleteDependency = impl.deleteDependency;
export const approveChange = impl.approveChange;
export const rejectChange = impl.rejectChange;
export const sendNotifications = impl.sendNotifications;
export const computePreview = impl.computePreview;
export const demoIncident = impl.demoIncident;
export const ackNotifyJob = (impl as { ackNotifyJob?: typeof mock.ackNotifyJob }).ackNotifyJob ?? mock.ackNotifyJob;
export type { ClientState, ReportInput, ReportResult, SaveResult } from './mockApi';