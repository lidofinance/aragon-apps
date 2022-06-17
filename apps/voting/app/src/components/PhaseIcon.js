import { IconClock, IconProhibited, IconVote, theme } from '@aragon/ui'
import React from 'react'
import styled from 'styled-components'
import { useVotePhase } from '../hooks/useVotePhase'

export const PhaseIcon = ({ vote }) => {
  const { isMainPhase, isObjectionPhase } = useVotePhase(vote)

  if (isMainPhase) {
    return (
      <IconContainer>
        <IconVote />
      </IconContainer>
    )
  }

  if (isObjectionPhase) {
    return (
      <IconContainer>
        <IconProhibited />
      </IconContainer>
    )
  }

  return (
    <IconContainer>
      <IconClock />
    </IconContainer>
  )
}

const IconContainer = styled.div`
  display: flex;
  align-items: center;
  color: #08bee5;
  margin: 6px 0;
`
