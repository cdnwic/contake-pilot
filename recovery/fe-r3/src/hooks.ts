import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as api from './api/mockApi';
import type { ProposedChange, Role, TaskNode } from './contracts/contake-core-contracts.v1.1';
import { useSession } from './state';

const key = (profileId: string, role: Role) => ['client-state', profileId, role];

export function useClientState() {
  const { profileId, role } = useSession();
  return useQuery({
    queryKey: key(profileId, role),
    queryFn: () => api.getClientState(profileId, role),
    staleTime: 5_000,
  });
}

function useInvalidator() {
  const qc = useQueryClient();
  const { profileId, role } = useSession();
  return () => qc.invalidateQueries({ queryKey: key(profileId, role) });
}

export function usePrincipal() {
  const { profileId, role } = useSession();
  return api.principalFor(profileId, role);
}

export function useSubmitReport() {
  const invalidate = useInvalidator();
  const { profileId } = useSession();
  const principal = usePrincipal();
  return useMutation({
    mutationFn: (input: api.ReportInput) => api.submitReport(profileId, input, principal),
    onSuccess: invalidate,
  });
}

export function useSaveTask() {
  const invalidate = useInvalidator();
  const { profileId } = useSession();
  const principal = usePrincipal();
  return useMutation({
    mutationFn: ({ taskId, draft }: { taskId: string | null; draft: Partial<TaskNode> & { name: string } }) =>
      api.saveTask(profileId, taskId, draft, principal),
    onSuccess: invalidate,
  });
}

export function useDeleteTask() {
  const invalidate = useInvalidator();
  const { profileId } = useSession();
  const principal = usePrincipal();
  return useMutation({
    mutationFn: (taskId: string) => api.deleteTask(profileId, taskId, principal),
    onSuccess: invalidate,
  });
}

export function useApproveChange() {
  const invalidate = useInvalidator();
  const { profileId } = useSession();
  const principal = usePrincipal();
  return useMutation({
    mutationFn: (changeId: string) => api.approveChange(profileId, changeId, principal),
    onSuccess: invalidate,
  });
}

export function useRejectChange() {
  const invalidate = useInvalidator();
  const { profileId } = useSession();
  const principal = usePrincipal();
  return useMutation({
    mutationFn: (changeId: string) => api.rejectChange(profileId, changeId, principal),
    onSuccess: invalidate,
  });
}

export function useSendNotifications() {
  const invalidate = useInvalidator();
  const { profileId } = useSession();
  const principal = usePrincipal();
  return useMutation({
    mutationFn: () => api.sendNotifications(profileId, principal),
    onSuccess: invalidate,
  });
}

export function useComputePreview() {
  const { profileId } = useSession();
  return useMutation({
    mutationFn: (change: ProposedChange) => api.computePreview(profileId, change),
  });
}

export function useDemoIncident() {
  const { profileId } = useSession();
  return api.demoIncident(profileId);
}
export { api };
export function useSaveDependency() {
  const invalidate = useInvalidator();
  const { profileId } = useSession();
  const principal = usePrincipal();
  return useMutation({
    mutationFn: ({ fromTaskId, toTaskId }: { fromTaskId: string; toTaskId: string }) =>
      api.saveDependency(profileId, fromTaskId, toTaskId, principal),
    onSuccess: invalidate,
  });
}

export function useDeleteDependency() {
  const invalidate = useInvalidator();
  const { profileId } = useSession();
  const principal = usePrincipal();
  return useMutation({
    mutationFn: (dependencyId: string) => api.deleteDependency(profileId, dependencyId, principal),
    onSuccess: invalidate,
  });
}
