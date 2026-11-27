import { examOf } from '../shared/exam'

/**
 * この画面がどの試験のものか。ビルド時に VITE_EXAM で決まる（`.env` の既定は ip。登録簿に無い key では読み込みで止まる）。
 *
 * 実行時に切り替えないのは、試験ごとにデータベースもデプロイ先も別だから。
 * 1つのビルドが2試験を跨ぐことはない。
 */
export const exam = examOf(import.meta.env.VITE_EXAM as string | undefined)
