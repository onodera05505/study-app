import { examOf } from '../shared/exam'

/**
 * この画面がどの試験のものか。ビルド時に VITE_EXAM で決まる（未指定なら ip）。
 *
 * 実行時に切り替えないのは、試験ごとにデータベースもデプロイ先も別だから。
 * 1つのビルドが2試験を跨ぐことはない。
 */
export const exam = examOf(import.meta.env.VITE_EXAM as string | undefined)
