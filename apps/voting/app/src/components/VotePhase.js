import React from 'react'
import { GU, textStyle, Timer, useTheme } from '@aragon/ui'
import styled from 'styled-components'
import { useVotePhase } from '../hooks/useVotePhase'

const VotePhase = ({ vote }) => {
  const theme = useTheme()
  const { isMainPhase, isObjectionPhase } = useVotePhase(vote)

  if (isMainPhase) {
    return (
      <div
        css={`
          ${textStyle('body2')};
          color: ${theme.contentSecondary};
        `}
      >
        <PhaseLabel>Main phase</PhaseLabel>
        <Timer end={vote.data.objectionPhaseStartDate} maxUnits={4} />
      </div>
    )
  }

  if (isObjectionPhase) {
    return (
      <div
        css={`
          ${textStyle('body2')};
          color: ${theme.contentSecondary};
        `}
      >
        <PhaseLabel>Objections phase</PhaseLabel>
        <Timer end={vote.data.endDate} maxUnits={4} />
      </div>
    )
  }

  return (
    <div
      css={`
        ${textStyle('body2')};
        color: ${theme.contentSecondary};
      `}
    >
      <p>Voting over</p>
    </div>
  )
}

const PhaseLabel = styled.p`
  margin-bottom: ${GU}px;
`

export default VotePhase
