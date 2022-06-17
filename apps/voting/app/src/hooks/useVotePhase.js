import { isAfter, isBefore } from 'date-fns'
import useNow from './useNow'

export const useVotePhase = vote => {
  const now = useNow()

  const { open, objectionPhaseStartDate, endDate, executed } = vote.data

  const isMainPhase = open && isBefore(now, objectionPhaseStartDate)
  const isObjectionPhase =
    isAfter(now, objectionPhaseStartDate) && isBefore(now, endDate)
  const voteOver = !open || (open && !executed)

  const canVoteYes = open && !isObjectionPhase
  const canVoteNo = open

  return {
    isMainPhase,
    isObjectionPhase,
    canVoteYes,
    canVoteNo,
    voteOver,
  }
}
