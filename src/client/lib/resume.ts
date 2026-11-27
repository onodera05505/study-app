/** 前回の続きの導線から論点の画面へ、また論点の画面から単元の一覧へ渡す画面遷移の状態。
 *  論点の画面は、導線から開いたかどうかで NOT_FOUND の扱いを分ける（導線を経ずに開いたときは取れなかったと示す）。 */

/** 前回の続きの導線から開いた印。 */
export type ResumeLinkState = { fromResumeLink: true }

export const RESUME_LINK_STATE: ResumeLinkState = { fromResumeLink: true }

// @implements REQ-342
export function isFromResumeLink(state: unknown): boolean {
  return !!state && typeof state === 'object' && (state as Partial<ResumeLinkState>).fromResumeLink === true
}

/** 前回の続きの論点が見つからなかったことを単元の一覧に知らせる状態。term は覚えていた論点の名前。 */
export type ResumeGoneState = { resumeGone: { term: string | null } }

// @implements REQ-342
export function resumeGoneOf(state: unknown): { term: string | null } | null {
  if (!state || typeof state !== 'object') return null
  const g = (state as Partial<ResumeGoneState>).resumeGone
  return g && typeof g === 'object' ? { term: typeof g.term === 'string' ? g.term : null } : null
}
