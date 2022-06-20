import React, { useEffect, useState, useCallback } from 'react'
import styled from 'styled-components'
import {
  blockExplorerUrl,
  Button,
  GU,
  Help,
  IconCheck,
  IconConnect,
  IconCross,
  Info,
  Link,
  RADIUS,
  textStyle,
  useTheme,
} from '@aragon/ui'
import { useAppState, useConnectedAccount, useNetwork } from '@aragon/api-react'
import useExtendedVoteData from '../hooks/useExtendedVoteData'
import { noop, formatDate } from '../utils'
import { VOTE_NAY, VOTE_YEA } from '../vote-types'
import { isVoteAction } from '../vote-utils'
import { useVotePhase } from '../hooks/useVotePhase'

const VoteActions = React.memo(({ vote, onVoteYes, onVoteNo, onExecute }) => {
  const [ready, setReady] = useState(false)
  const theme = useTheme()
  const connectedAccount = useConnectedAccount()
  const { tokenSymbol } = useAppState()
  const [changeVote, setChangeVote] = useState(false)
  const handleChangeVote = useCallback(() => setChangeVote(true), [])

  const { connectedAccountVote, data } = vote
  const { snapshotBlock, startDate, open } = data
  const {
    canUserVote,
    canExecute,
    userBalance,
    userBalanceNow,
    canUserVotePromise,
    userBalancePromise,
    userBalanceNowPromise,
    canExecutePromise,
  } = useExtendedVoteData(vote)
  const hasVoted = [VOTE_YEA, VOTE_NAY].includes(connectedAccountVote)

  useEffect(() => {
    let cancelled = false

    const whenReady = async () => {
      await Promise.all([
        canUserVotePromise,
        canExecutePromise,
        userBalancePromise,
        userBalanceNowPromise,
      ])
      if (!cancelled) {
        setReady(true)
      }
    }
    setReady(false)
    whenReady()

    return () => {
      cancelled = true
    }
  }, [
    userBalancePromise,
    canUserVotePromise,
    canExecutePromise,
    userBalanceNowPromise,
  ])

  const { canVoteYes, canVoteNo } = useVotePhase(vote)

  if (!ready) {
    return null
  }

  if (!open) {
    return (
      <React.Fragment>
        {canExecute && isVoteAction(vote) && (
          <React.Fragment>
            <Button mode="strong" onClick={onExecute} wide>
              Enact this vote
            </Button>
            <Info>
              The voting period is closed and the vote has passed.{' '}
              <strong>Anyone</strong> can now enact this vote to execute its
              action.
            </Info>
          </React.Fragment>
        )}
      </React.Fragment>
    )
  }

  if (canUserVote && hasVoted && !changeVote) {
    return (
      <div>
        <Button
          mode="strong"
          onClick={handleChangeVote}
          wide
          css={`
            margin-bottom: ${2 * GU}px;
          `}
        >
          Change my vote
        </Button>
        <Info>
          During the main phase, you can <strong>change your vote</strong> as
          many times as you wish. In the objections phase, however, you can only
          change your vote to <strong>NO</strong>.
        </Info>
      </div>
    )
  }

  if (canUserVote) {
    return (
      <div>
        {connectedAccount ? (
          <React.Fragment>
            <Buttons
              onClickYes={onVoteYes}
              onClickNo={onVoteNo}
              disabledYes={!canVoteYes}
              disabledNo={!canVoteNo}
            />
            <TokenReference
              snapshotBlock={snapshotBlock}
              startDate={startDate}
              tokenSymbol={tokenSymbol}
              userBalance={userBalance}
              userBalanceNow={userBalanceNow}
            />
          </React.Fragment>
        ) : (
          <div
            css={`
              border-radius: ${RADIUS}px;
              background: ${theme.background};
              padding: ${3.5 * GU}px ${10 * GU}px;
              text-align: center;
            `}
          >
            <div
              css={`
                ${textStyle('body1')};
              `}
            >
              You must enable your account to vote on this proposal
            </div>
            <div
              css={`
                ${textStyle('body2')};
                color: ${theme.surfaceContentSecondary};
                margin-top: ${2 * GU}px;
              `}
            >
              Connect to your Ethereum provider by clicking on the{' '}
              <strong
                css={`
                  display: inline-flex;
                  align-items: center;
                  position: relative;
                  top: 7px;
                `}
              >
                <IconConnect /> Enable account
              </strong>{' '}
              button on the header. You may be temporarily redirected to a new
              screen.
            </div>
          </div>
        )}
      </div>
    )
  }

  return (
    <div>
      <Buttons disabledYes={!canVoteYes} disabledNo={!canVoteNo} />
      <Info mode="warning">
        {userBalanceNow > 0
          ? 'Although the currently connected account holds tokens, it'
          : 'The currently connected account'}{' '}
        did not hold any <strong>{tokenSymbol}</strong> tokens when this vote
        began ({formatDate(startDate)}) and therefore cannot participate in this
        vote. Make sure your accounts are holding <strong>{tokenSymbol}</strong>{' '}
        at the time a vote begins if you'd like to vote using this Voting app.
      </Info>
    </div>
  )
})

const Buttons = ({
  onClickYes = noop,
  onClickNo = noop,
  disabledYes = false,
  disabledNo = false,
}) => (
  <ButtonsContainer>
    <VotingButton
      mode="positive"
      wide
      disabled={disabledYes}
      onClick={onClickYes}
    >
      <IconCheck
        size="small"
        css={`
          margin-right: ${1 * GU}px;
        `}
      />
      Yes{' '}
      {disabledYes && (
        <div
          css={`
            margin-left: 6px;
          `}
        >
          <Help hint="What are voting phases?">
            Each voting comes in two phases. In the first phase (or Main phase),
            participants can either vote pro or contra, whereas in the second
            phase only objections can be submitted.
          </Help>
        </div>
      )}
    </VotingButton>
    <VotingButton
      mode="negative"
      wide
      disabled={disabledNo}
      onClick={onClickNo}
    >
      <IconCross
        size="small"
        css={`
          margin-right: ${1 * GU}px;
        `}
      />
      No
    </VotingButton>
  </ButtonsContainer>
)

const ButtonsContainer = styled.div`
  display: flex;
  margin-bottom: ${2 * GU}px;
`

const TokenReference = ({
  snapshotBlock,
  startDate,
  tokenSymbol,
  userBalance,
  userBalanceNow,
}) => (
  <Info>
    Voting with{' '}
    <strong>
      {userBalance} {tokenSymbol}
    </strong>{' '}
    . This was your balance when the vote started (block{' '}
    <BlockNumber blockNumber={snapshotBlock} />, mined at{' '}
    <strong>{formatDate(startDate)}</strong>).{' '}
    {userBalance !== userBalanceNow ? (
      <span>
        Your current balance is{' '}
        <strong>
          {userBalanceNow} {tokenSymbol}
        </strong>
        )
      </span>
    ) : (
      ''
    )}
  </Info>
)

function BlockNumber({ blockNumber }) {
  const network = useNetwork()

  return network ? (
    <Link
      href={blockExplorerUrl('block', blockNumber, {
        networkType: network.type,
      })}
    >
      {blockNumber}
    </Link>
  ) : (
    <strong>{blockNumber}</strong>
  )
}

const VotingButton = styled(Button)`
  ${textStyle('body2')};
  width: 50%;
  &:first-child {
    margin-right: ${1 * GU}px;
  }
`

export default VoteActions
