export type RequestSheetKind = 'approval' | 'input' | undefined;
export function nextRequestSheet(current: RequestSheetKind, desired: RequestSheetKind): { dismissCurrent: boolean; show: RequestSheetKind } { return current === undefined || current === desired ? { dismissCurrent: false, show: desired } : { dismissCurrent: true, show: undefined }; }
