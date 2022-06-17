import React from 'react'
import { GU, textStyle, Timer, useTheme } from '@aragon/ui'
import styled from 'styled-components'
import { useVotePhase } from '../hooks/useVotePhase'
import { PhaseIcon } from './PhaseIcon'

const VotePhase = ({ vote }) => {
  const theme = useTheme()
  const { isMainPhase, isObjectionPhase } = useVotePhase(vote)

  let phaseName = 'Voting over'
  if (isMainPhase) {
    phaseName = 'Main phase'
  } else if (isObjectionPhase) {
    phaseName = 'Objection phase'
  }

  return (
    <div
      css={`
        ${textStyle('body2')};
      `}
    >
      <PhaseContainer>
        <PhaseIcon vote={vote} />
        <div
          css={`
            color: ${theme.contentSecondary};
          `}
        >
          {phaseName}
        </div>
      </PhaseContainer>
      {isMainPhase && (
        <div
          css={`
            margin-top: ${2 * GU}px;
          `}
        >
          <div
            css={`
              ${textStyle('body2')};
              color: ${theme.surfaceContentSecondary};
              margin-bottom: ${1 * GU}px;
            `}
          >
            Objection phase in
          </div>
          <Timer end={vote.data.objectionPhaseStartDate} maxUnits={4} />
        </div>
      )}
    </div>
  )
}

const PhaseContainer = styled.span`
  display: flex;
  align-items: center;
`

export default VotePhase
