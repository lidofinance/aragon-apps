import { isAfter, isBefore } from 'date-fns'
import useNow from './useNow'

export const useVotePhase = vote => {
  const now = useNow()

  const { open, objectionPhaseStartDate, endDate } = vote.data

  const isMainPhase = open && isBefore(now, objectionPhaseStartDate)
  const isObjectionPhase =
    isAfter(now, objectionPhaseStartDate) && isBefore(now, endDate)

  const canVoteYes = isMainPhase
  const canVoteNo = isMainPhase || isObjectionPhase

  return {
    isMainPhase,
    isObjectionPhase,
    canVoteYes,
    canVoteNo,
  }
}
