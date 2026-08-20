export const RUN_TRANSITIONS = {
 created:['running','cancelled'], running:['waiting_for_user','paused','interrupted','failed','cancelled','completed'], waiting_for_user:['running','paused','interrupted','cancelled'], paused:['running','cancelled'], interrupted:['running','cancelled'], failed:['running'], cancelled:[], completed:[],
} as const;
export const STAGE_TRANSITIONS = {
 queued:['ready','skipped','cancelled'], ready:['running','skipped','cancelled'], running:['waiting_for_user','succeeded','failed','interrupted','cancelled'], waiting_for_user:['running','failed','interrupted','cancelled'], succeeded:[], failed:['running'], skipped:[], cancelled:[], interrupted:['running'],
} as const;
export const ATTEMPT_TRANSITIONS = { running:['succeeded','failed','interrupted'], succeeded:[], failed:[], interrupted:[] } as const;
export type RunStatus=keyof typeof RUN_TRANSITIONS; export type StageStatus=keyof typeof STAGE_TRANSITIONS; export type AttemptStatus=keyof typeof ATTEMPT_TRANSITIONS;
function assertTransition(map: Record<string,readonly string[]>, from:string,to:string,kind:string):void { if (!(map[from]??[]).includes(to)) throw new Error(`INVALID_TRANSITION: ${kind} ${from} -> ${to}`); }
export const assertRunTransition=(from:RunStatus,to:RunStatus):void=>assertTransition(RUN_TRANSITIONS,from,to,'run');
export const assertStageTransition=(from:StageStatus,to:StageStatus):void=>assertTransition(STAGE_TRANSITIONS,from,to,'stage');
export const assertAttemptTransition=(from:AttemptStatus,to:AttemptStatus):void=>assertTransition(ATTEMPT_TRANSITIONS,from,to,'attempt');
