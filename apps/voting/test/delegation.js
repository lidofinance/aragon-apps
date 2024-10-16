const ERRORS = require('./helpers/errors')
const assertArraysEqualAsSets = require('./helpers/assertArrayAsSets')
const { assertBn, assertRevert, assertAmountOfEvents, assertEvent } = require('@aragon/contract-helpers-test/src/asserts')
const { pct16, bigExp, getEventArgument, ZERO_ADDRESS } = require('@aragon/contract-helpers-test')
const { newDao, installNewApp, ANY_ENTITY, EMPTY_CALLS_SCRIPT } = require('@aragon/contract-helpers-test/src/aragon-os')
const { assert } = require('chai')
const { getStorageAt, setStorageAt, impersonateAccount } = require("@nomicfoundation/hardhat-network-helpers")

const Voting = artifacts.require('VotingMock')
const MiniMeToken = artifacts.require('MiniMeToken')

// Voting contract config
const NEEDED_SUPPORT = pct16(50)
const MIN_ACCEPTANCE_QUORUM = pct16(20)
const NOW = 1
const MAIN_PHASE_DURATION = 700
const OBJECTION_PHASE_DURATION = 300
const VOTING_DURATION = MAIN_PHASE_DURATION + OBJECTION_PHASE_DURATION
const APP_ID = '0x1234123412341234123412341234123412341234123412341234123412341234'

// Voting contract state constants
const VOTER_STATE = {
  ABSENT: "0",
  YEA: "1",
  NAY: "2",
  DELEGATE_YEA: "3",
  DELEGATE_NAY: "4"
}
const VOTE_PHASE = {
  MAIN: "0",
  OBJECTION: "1"
}
const VOTE_YEA_VALUE = true
const VOTE_NAY_VALUE = false

// Voting token parameter
const TOKEN_DECIMALS = 18

const ZERO_BN = bigExp(0, TOKEN_DECIMALS)

const getVoteIdFromReceipt = receipt => getEventArgument(receipt, 'StartVote', 'voteId')
const getVotingPowerSum = (balances) => balances.reduce((sum, balance) => sum.add(balance), ZERO_BN)

contract('Voting App (delegation)', ([root, holder1, holder2, holder20, holder29, holder51, delegate1, delegate2, nonHolder, ...spamHolders]) => {
  let votingBase, voting, token, voteId
  let CREATE_VOTES_ROLE, MODIFY_SUPPORT_ROLE, MODIFY_QUORUM_ROLE, UNSAFELY_MODIFY_VOTE_TIME_ROLE

  const voters = [holder1, holder2, holder20, holder29, holder51]
  const votersBalances = {
    [holder1]: bigExp(1, TOKEN_DECIMALS),
    [holder2]: bigExp(2, TOKEN_DECIMALS),
    [holder20]: bigExp(20, TOKEN_DECIMALS),
    [holder29]: bigExp(29, TOKEN_DECIMALS),
    [holder51]: bigExp(51, TOKEN_DECIMALS),
  }
  const defaultLimit = 100 // default limit for getDelegatedVoters

  before('load roles', async () => {
    votingBase = await Voting.new()
    CREATE_VOTES_ROLE = await votingBase.CREATE_VOTES_ROLE()
    MODIFY_SUPPORT_ROLE = await votingBase.MODIFY_SUPPORT_ROLE()
    MODIFY_QUORUM_ROLE = await votingBase.MODIFY_QUORUM_ROLE()
    UNSAFELY_MODIFY_VOTE_TIME_ROLE = await votingBase.UNSAFELY_MODIFY_VOTE_TIME_ROLE()
  })

  beforeEach('deploy DAO with Voting app', async () => {
    const { dao, acl } = await newDao(root)
    voting = await Voting.at(await installNewApp(dao, APP_ID, votingBase.address, root))
    await voting.mockSetTimestamp(NOW)
    await acl.createPermission(ANY_ENTITY, voting.address, CREATE_VOTES_ROLE, root, { from: root })
    await acl.createPermission(ANY_ENTITY, voting.address, MODIFY_SUPPORT_ROLE, root, { from: root })
    await acl.createPermission(ANY_ENTITY, voting.address, MODIFY_QUORUM_ROLE, root, { from: root })
    await acl.createPermission(ANY_ENTITY, voting.address, UNSAFELY_MODIFY_VOTE_TIME_ROLE, root, { from: root })
    // Initialize voting contract
    token = await MiniMeToken.new(ZERO_ADDRESS, ZERO_ADDRESS, 0, 'n', TOKEN_DECIMALS, 'n', true) // empty parameters minime
    await voting.initialize(token.address, NEEDED_SUPPORT, MIN_ACCEPTANCE_QUORUM, VOTING_DURATION, OBJECTION_PHASE_DURATION)
  })

  const startEmptyVote = async () => getVoteIdFromReceipt(await voting.newVote(EMPTY_CALLS_SCRIPT, 'metadata'))

  context('delegation state management', () => {
    it(`voter can't assign the zero address as a delegate`, async () => {
      await assertRevert(
        voting.assignDelegate(ZERO_ADDRESS, { from: voters[0] }),
        ERRORS.VOTING_ZERO_ADDRESS_PASSED
      )
    })

    it(`voter can't assign themself as a delegate`, async () => {
      await assertRevert(
        voting.assignDelegate(voters[0], { from: voters[0] }),
        ERRORS.VOTING_SELF_DELEGATE
      )
    })

    it(`voter can't assign their current delegate as a delegate`, async () => {
      await voting.assignDelegate(delegate1, { from: voters[0] })
      await assertRevert(
        voting.assignDelegate(delegate1, { from: voters[0] }),
        ERRORS.VOTING_DELEGATE_SAME_AS_PREV
      )
    })

    it(`voter can't unassign their delegate if they wasn't assigned before`, async () => {
      await assertRevert(
        voting.unassignDelegate({ from: voters[0] }),
        ERRORS.VOTING_DELEGATE_NOT_SET
      )
    })

    it('voter can assign a delegate', async () => {
      let delegatedVoters = await voting.getDelegatedVoters(delegate1, 0, defaultLimit)
      assert.equal(delegatedVoters.length, 0, 'delegate1 should not be a delegate of anyone')

      const tx = await voting.assignDelegate(delegate1, { from: voters[0] })
      assertEvent(tx, 'AssignDelegate', {
        expectedArgs: { voter: voters[0], assignedDelegate: delegate1 }
      })
      assertAmountOfEvents(tx, 'AssignDelegate', { expectedAmount: 1 })

      const delegate = await voting.getDelegate(voters[0])
      assert.equal(delegate, delegate1)

      delegatedVoters = await voting.getDelegatedVoters(delegate1, 0, defaultLimit)
      assertArraysEqualAsSets(delegatedVoters, [voters[0]])
    })

    it(`assignment fails if delegatedVoters array is overflown`, async () => {
      const arrayLengthSlotIndex = 5
      const paddedAddress = ethers.utils.hexZeroPad(delegate1, 32)
      const paddedSlot = ethers.utils.hexZeroPad(arrayLengthSlotIndex, 32)
      const arrayLengthSlot = ethers.utils.solidityKeccak256(['address', 'uint256'], [paddedAddress, paddedSlot])

      // Check that slot index is correct
      let storage = await getStorageAt(voting.address, arrayLengthSlot)
      assert(ethers.BigNumber.from(storage).eq(0), 'delegatedVoters array length should be 0')

      await voting.assignDelegate(delegate1, { from: voters[0] })
      storage = await getStorageAt(voting.address, arrayLengthSlot)
      assert(ethers.BigNumber.from(storage).eq(1), 'delegatedVoters array length should be 1 after assignment')

      // Update slot value to max uint96 - 1
      const uint96MaxMinusOne = ethers.BigNumber.from(2).pow(96).sub(1)
      await setStorageAt(voting.address, arrayLengthSlot, uint96MaxMinusOne)
      // Should successfully assign delegate
      const tx = await voting.assignDelegate(delegate1, { from: voters[1] })
      assertEvent(tx, 'AssignDelegate', {
        expectedArgs: { voter: voters[1], assignedDelegate: delegate1 }
      })
      assertAmountOfEvents(tx, 'AssignDelegate', { expectedAmount: 1 })

      // Check that revert is thrown when trying to assign a delegate if the capacity is reached
      await assertRevert(
        voting.assignDelegate(delegate1, { from: voters[2] }),
        ERRORS.VOTING_MAX_DELEGATED_VOTERS_REACHED
      )
    })

    it('single voter can unassign a delegate', async () => {
      let delegatedVoters = await voting.getDelegatedVoters(delegate1, 0, defaultLimit)
      assert.equal(delegatedVoters.length, 0, 'delegate1 should not be a delegate of anyone')

      await voting.assignDelegate(delegate1, { from: voters[0] })

      delegatedVoters = await voting.getDelegatedVoters(delegate1, 0, defaultLimit)
      assertArraysEqualAsSets(delegatedVoters, [voters[0]])

      const tx = await voting.unassignDelegate({ from: voters[0] })
      assertEvent(tx, 'UnassignDelegate', {
        expectedArgs: { voter: voters[0], unassignedDelegate: delegate1 }
      })
      assertAmountOfEvents(tx, 'UnassignDelegate', { expectedAmount: 1 })
      delegatedVoters = await voting.getDelegatedVoters(delegate1, 0, defaultLimit)
      assertArraysEqualAsSets(delegatedVoters, [], 'delegate1 should not be a delegate of anyone')
    })

    it('multiple voters can unassign a delegate', async () => {
      let delegatedVoters = await voting.getDelegatedVoters(delegate1, 0, defaultLimit)
      assert.equal(delegatedVoters.length, 0, 'delegate1 should not be a delegate of anyone')

      for (const voter of voters) {
        await voting.assignDelegate(delegate1, { from: voter })
      }

      const tx1 = await voting.unassignDelegate({ from: voters[0] })
      assertEvent(tx1, 'UnassignDelegate', {
        expectedArgs: { voter: voters[0], unassignedDelegate: delegate1 }
      })
      assertAmountOfEvents(tx1, 'UnassignDelegate', { expectedAmount: 1 })
      delegatedVoters = await voting.getDelegatedVoters(delegate1, 0, defaultLimit)
      assertArraysEqualAsSets(delegatedVoters, voters.slice(1))

      const tx2 = await voting.unassignDelegate({ from: voters[1] })
      assertEvent(tx2, 'UnassignDelegate', {
        expectedArgs: { voter: voters[1] , unassignedDelegate: delegate1 }
      })
      assertAmountOfEvents(tx2, 'UnassignDelegate', { expectedAmount: 1 })
      delegatedVoters = await voting.getDelegatedVoters(delegate1, 0, defaultLimit)
      assertArraysEqualAsSets(delegatedVoters, voters.slice(2))
    })

    it('voter can change delegate', async () => {
      let delegatedVoters = await voting.getDelegatedVoters(delegate1, 0, defaultLimit)
      assert.equal(delegatedVoters.length, 0, 'delegate1 should not be a delegate of anyone')
      delegatedVoters = await voting.getDelegatedVoters(delegate2, 0, defaultLimit)
      assert.equal(delegatedVoters.length, 0, 'delegate2 should not be a delegate of anyone')

      for (const voter of voters) {
        await voting.assignDelegate(delegate1, { from: voter })
      }

      await voting.assignDelegate(delegate2, { from: voters[0] })

      const delegatedVotersDelegate1 = await voting.getDelegatedVoters(delegate1, 0, defaultLimit)
      assertArraysEqualAsSets(delegatedVotersDelegate1, voters.slice(1))
      const delegatedVotersDelegate2 = await voting.getDelegatedVoters(delegate2, 0, defaultLimit)
      assertArraysEqualAsSets(delegatedVotersDelegate2, [voters[0]])
    })
  })

  context('delegation state getters', () => {
    beforeEach(async () => {
      // Generate voting tokens for voters and assign delegate1 as a delegate for all of them
      for (const voter of voters) {
        await token.generateTokens(voter, votersBalances[voter])
        await voting.assignDelegate(delegate1, { from: voter })
      }
    })

    //
    // getDelegatedVotersCount
    //
    it('should return empty array if there are no delegated voters', async () => {
      const delegatedVotersCount = (await voting.getDelegatedVotersCount(delegate2)).toNumber()
      assert(delegatedVotersCount === 0)
    })

    it('should return correct delegated voters count', async () => {
      const delegatedVotersCount = (await voting.getDelegatedVotersCount(delegate1)).toNumber()
      assert(delegatedVotersCount === voters.length)
    })

    it(`getDelegatedVotersCount: revert if "_delegate" is zero address`, async () => {
      await assertRevert(
        voting.getDelegatedVotersCount(ZERO_ADDRESS),
        ERRORS.VOTING_ZERO_ADDRESS_PASSED
      )
    })

    //
    // getDelegatedVoters
    //
    it(`getDelegatedVoters: revert if "_delegate" is zero address`, async () => {
      await assertRevert(
        voting.getDelegatedVoters(ZERO_ADDRESS, 0, defaultLimit),
        ERRORS.VOTING_ZERO_ADDRESS_PASSED
      )
    })

    it(`if "_limit" is 0, return empty array`, async () => {
      const delegatedVoters = await voting.getDelegatedVoters(nonHolder, 0, 0)
      assert(delegatedVoters.length === 0, 'votersList should be empty')
    })

    it(`if offset is more than length, return empty array`, async () => {
      const delegatedVoters = await voting.getDelegatedVoters(nonHolder, voters.length + 1, defaultLimit)
      assert(delegatedVoters.length === 0, 'votersList should be empty')
    })

    it(`if delegatedVoters array length is 0, return empty array`, async () => {
      const delegatedVoters = await voting.getDelegatedVoters(nonHolder, 0, defaultLimit)
      assert(delegatedVoters.length === 0, 'votersList should be empty')
    })

    it(`should return correct delegatedVoters array if offset + limit >= votersCount`, async () => {
      const offset = 2
      const limit = 5
      const delegatedVoters = await voting.getDelegatedVoters(delegate1, offset, limit)
      const delegatedVotersCount = (await voting.getDelegatedVotersCount(delegate1)).toNumber()
      const delegatedVotersCountToReturn = delegatedVotersCount - offset

      assert(delegatedVoters.length === delegatedVotersCountToReturn)

      const votersSlice = voters.slice(offset, delegatedVotersCount)
      assertArraysEqualAsSets(delegatedVoters, votersSlice, 'votersList should be correct')
    })

    it(`should return correct delegated voters data if offset + limit < votersCount`, async () => {
      const offset = 1
      const limit = 1
      const delegatedVoters = await voting.getDelegatedVoters(delegate1, offset, limit)

      assert(delegatedVoters.length === limit)

      const votersSlice = voters.slice(offset, offset + limit)
      assertArraysEqualAsSets(delegatedVoters, votersSlice, 'votersList should be correct')
    })

    //
    // getDelegate
    //
    it(`revert if _voter is zero address`, async () => {
      await assertRevert(
        voting.getDelegate(ZERO_ADDRESS),
        ERRORS.VOTING_ZERO_ADDRESS_PASSED
      )
    })

    it(`return zero address if no delegate`, async () => {
      const delegate = await voting.getDelegate(nonHolder)
      assert.equal(delegate, ZERO_ADDRESS, 'should return zero address')
    })

    it(`can get voter's delegate address`, async () => {
      const delegate = await voting.getDelegate(voters[0])
      assert.equal(delegate, delegate1, 'should return delegate1 address')
    })

    //
    // getVotingPowerMultiple, getVotingPowerMultipleAtVote
    //
    it(`can't get voting power at vote that doesn't exist`, async () => {
      voteId = await startEmptyVote()

      await assertRevert(
        voting.getVotingPowerMultipleAtVote(voteId + 1, voters),
        ERRORS.VOTING_NO_VOTE
      )
    })

    it(`voting power getters are working correctly`, async () => {
      voteId = await startEmptyVote()

      const initialVotingPower = Object.values(votersBalances).map(balance => balance.toString())
      const currentVotingPower = await voting.getVotingPowerMultiple(voters)
      assertArraysEqualAsSets(currentVotingPower, initialVotingPower, 'current voting power values should match')

      const updatedVoterIndex = 0
      const vpAddition = bigExp(1, TOKEN_DECIMALS)
      await token.generateTokens(voters[updatedVoterIndex], vpAddition)
      const updatedVotingPowerToCompare = voters.map((v, i) => {
        if (i === updatedVoterIndex) {
          return votersBalances[v].add(vpAddition).toString()
        }
        return votersBalances[v].toString()
      })
      const updatedVotingPower = await voting.getVotingPowerMultiple(voters)
      assertArraysEqualAsSets(updatedVotingPower, updatedVotingPowerToCompare, 'current voting power values should match after update')

      const votingPowerAtVote = await voting.getVotingPowerMultipleAtVote(voteId, voters)
      assertArraysEqualAsSets(votingPowerAtVote, initialVotingPower, 'voting power at vote should match vp without update')
    })

    //
    // getVoterStateMultipleAtVote
    //
    it(`getVoterStateMultipleAtVote: revert if vote does not exist`, async () => {
      voteId = await startEmptyVote()

      await assertRevert(
        voting.getVoterStateMultipleAtVote(voteId + 1, [voters[0]]),
        ERRORS.VOTING_NO_VOTE
      )
    })

    it(`can get correct voterState for a list of voters`, async () => {
      voteId = await startEmptyVote()

      const votersSlice = voters.slice(0, 3)

      await voting.vote(voteId, VOTE_YEA_VALUE, false, { from: votersSlice[0] })
      await voting.vote(voteId, VOTE_NAY_VALUE, false, { from: votersSlice[1] })
      await voting.attemptVoteForMultiple(voteId, false, [votersSlice[2]], { from: delegate1 })

      const votersState = await voting.getVoterStateMultipleAtVote(voteId, votersSlice)
      assert.equal(votersState[0], VOTER_STATE.YEA)
      assert.equal(votersState[1], VOTER_STATE.NAY)
      assert.equal(votersState[2], VOTER_STATE.DELEGATE_NAY)
    })
  })

  context('voting as delegate', () => {
    beforeEach(async () => {
      for (const voter of voters) {
        await token.generateTokens(voter, votersBalances[voter])
        await voting.assignDelegate(delegate1, { from: voter })
      }

      voteId = await startEmptyVote()
    })

    it(`revert if vote does not exist`, async () => {
      await assertRevert(
        voting.attemptVoteForMultiple(voteId + 1, VOTE_NAY_VALUE, voters, { from: delegate1 }),
        ERRORS.VOTING_NO_VOTE
      )
    })

    it(`revert if vote has already ended`, async () => {
      await voting.mockIncreaseTime(VOTING_DURATION + 1)
      await assertRevert(
        voting.attemptVoteForMultiple(voteId, VOTE_NAY_VALUE, voters, { from: delegate1 }),
        ERRORS.VOTING_CAN_NOT_VOTE
      )
    })

    it(`revert if vote has already been executed`, async () => {
      const voter = voters[voters.length - 1]
      await voting.vote(voteId, VOTE_YEA_VALUE, false, { from: voter })
      await voting.mockIncreaseTime(VOTING_DURATION + 1)
      await voting.executeVote(voteId)

      await assertRevert(
        voting.attemptVoteForMultiple(voteId, VOTE_YEA_VALUE, [voter], { from: delegate1 }),
        ERRORS.VOTING_CAN_NOT_VOTE
      )
    })

    it(`revert if trying to vote 'yea' during objection phase`, async () => {
      await voting.mockIncreaseTime(VOTING_DURATION - OBJECTION_PHASE_DURATION)
      assert.equal((await voting.getVote(voteId)).phase, VOTE_PHASE.OBJECTION, 'vote should be in the objection phase')
      await assertRevert(
        voting.attemptVoteForMultiple(voteId, VOTE_YEA_VALUE, voters, { from: delegate1 }),
        ERRORS.VOTING_CAN_NOT_VOTE
      )
    })

    it(`revert if one of the voters has 0 voting power`, async () => {
      await voting.assignDelegate(delegate1, { from: nonHolder })
      await assertRevert(
        voting.attemptVoteForMultiple(voteId, VOTE_YEA_VALUE, [nonHolder, ...voters], { from: delegate1 }),
        ERRORS.VOTING_NO_VOTING_POWER
      )
    })

    it(`skip zero address passed`, async () => {
      await token.generateTokens(ZERO_ADDRESS, bigExp(1, TOKEN_DECIMALS))
      voteId = await startEmptyVote()
      const voter = voters[0]
      // Skip if zero address is one of the voters
      let tx = await voting.attemptVoteForMultiple(voteId, VOTE_YEA_VALUE, [voter, ZERO_ADDRESS], { from: delegate1 })
      assertAmountOfEvents(tx, 'CastVote', { expectedAmount: 1 })
      assertEvent(tx, 'CastVote', { expectedArgs: { voteId, voter, supports: VOTE_YEA_VALUE } })

      // Revert if zero address is a delegate (can't delegate to zero address)
      // This test was added to improve test coverage
      await impersonateAccount(ZERO_ADDRESS)
      const signerZero = await ethers.getSigner(ZERO_ADDRESS)
      const signers = await ethers.getSigners();
      await signers[0].sendTransaction({
        to: signerZero.address,
        value: ethers.utils.parseEther("1.0"),
      });

      // The revert is expected because the delegate is zero address, so it's
      // impossible to delegate to it. But voter will be skipped.
      await assertRevert(
        voting.attemptVoteForMultiple(voteId, VOTE_YEA_VALUE, [voter], { from: signerZero.address }),
        ERRORS.VOTING_CAN_NOT_VOTE_FOR
      )
    })

    it(`one of the voters has voted beforehand`, async () => {
      const [selfVoter, ...restVoters] = voters
      await voting.vote(voteId, VOTE_NAY_VALUE, false, { from: selfVoter })
      const tx = await voting.attemptVoteForMultiple(voteId, VOTE_YEA_VALUE, voters, { from: delegate1 })

      assertAmountOfEvents(tx, 'CastVote', { expectedAmount: restVoters.length })
      assertAmountOfEvents(tx, 'AttemptCastVoteAsDelegate', { expectedAmount: 1 })
      for (let index = 0; index < restVoters.length; index++) {
        assertEvent(tx, 'CastVote', { index, expectedArgs: { voteId, voter: restVoters[index], supports: VOTE_YEA_VALUE } })
      }
      assertEvent(tx, 'AttemptCastVoteAsDelegate', { expectedArgs: { voteId, delegate: delegate1 } })
      const votersFromEvent = getEventArgument(tx, 'AttemptCastVoteAsDelegate', 'voters')
      assertArraysEqualAsSets(votersFromEvent, voters)

      assert.equal(await voting.getVoterState(voteId, selfVoter), VOTER_STATE.NAY, `selfVoter should have 'nay' state`)
      const votersState = await voting.getVoterStateMultipleAtVote(voteId, restVoters)
      votersState.every((state) => {
        assert.equal(state, VOTER_STATE.DELEGATE_YEA, `voter should have 'delegateYea' state`)
      })
    })

    it(`vote for multiple with duplicates`, async () => {
      const duplicatedVoter = voters[0]
      const votersListWithDuplicates = [duplicatedVoter, ...voters]
      const tx = await voting.attemptVoteForMultiple(voteId, VOTE_NAY_VALUE, votersListWithDuplicates, { from: delegate1 })

      // The amount of CastEvents includes the duplicated voter
      assertAmountOfEvents(tx, 'CastVote', { expectedAmount: votersListWithDuplicates.length })
      assertAmountOfEvents(tx, 'AttemptCastVoteAsDelegate', { expectedAmount: 1 })
      for (let index = 0; index < votersListWithDuplicates.length; index++) {
        assertEvent(tx, 'CastVote', { index, expectedArgs: { voteId, voter: votersListWithDuplicates[index], supports: VOTE_NAY_VALUE } })
      }
      assertEvent(tx, 'AttemptCastVoteAsDelegate', { expectedArgs: { voteId, delegate: delegate1 } })
      const votersFromEvent = getEventArgument(tx, 'AttemptCastVoteAsDelegate', 'voters')
      assertArraysEqualAsSets(votersFromEvent, votersListWithDuplicates)
      assert.equal(await voting.getVoterState(voteId, duplicatedVoter), VOTER_STATE.DELEGATE_NAY, `duplicatedVoter should have 'delegateNay' state`)

      const voteNayVP = (await voting.getVote(voteId)).nay
      const votersVP = await voting.getVotingPowerMultipleAtVote(voteId, voters)
      const votersVPSum = getVotingPowerSum(votersVP)
      assertBn(voteNayVP, votersVPSum, 'nay should be the sum of all VP with duplicates')
    })

    it(`vote for empty list`, async () => {
      await assertRevert(
        voting.attemptVoteForMultiple(voteId, false, [], { from: delegate1 }),
        ERRORS.VOTING_CAN_NOT_VOTE_FOR
      )
    })

    it(`skipped vote for multiple for all voters from list`, async () => {
      for (const voter of voters) {
        await voting.vote(voteId, VOTE_NAY_VALUE, false, { from: voter })
      }
      await assertRevert(
        voting.attemptVoteForMultiple(voteId, VOTE_NAY_VALUE, voters, { from: delegate1 }),
        ERRORS.VOTING_CAN_NOT_VOTE_FOR
      )
    })

    it(`successful vote for multiple`, async () => {
      const delegatedVotersAddresses = await voting.getDelegatedVoters(delegate1, 0, defaultLimit)
      const delegatedVotersVotingPower = await voting.getVotingPowerMultipleAtVote(voteId, delegatedVotersAddresses)
      const delegatedVotersState = (await voting.getVoterStateMultipleAtVote(voteId, delegatedVotersAddresses)).map(state => state.toString())
      const eligibleDelegatedVoters = []
      for (let i = 0; i < delegatedVotersAddresses.length; i++) {
        const votingPower = delegatedVotersVotingPower[i]
        const voterState = delegatedVotersState[i]
        if (votingPower.gt(ZERO_BN) && voterState !== VOTER_STATE.YEA && voterState !== VOTER_STATE.NAY) {
          eligibleDelegatedVoters.push({ address: delegatedVotersAddresses[i], votingPower })
        }
      }
      const eligibleDelegatedVotersAddresses = eligibleDelegatedVoters.map(({ address }) => address)
      const tx = await voting.attemptVoteForMultiple(
        voteId,
        VOTE_NAY_VALUE,
        eligibleDelegatedVotersAddresses,
        { from: delegate1 }
      )

      // Check amount of events
      assertAmountOfEvents(tx, 'CastVote', { expectedAmount: eligibleDelegatedVoters.length })
      assertAmountOfEvents(tx, 'AttemptCastVoteAsDelegate', { expectedAmount: 1 })

      // Check events content
      for (let index = 0; index < eligibleDelegatedVoters.length; index++) {
        const { address, votingPower } = eligibleDelegatedVoters[index]
        assertEvent(tx, 'CastVote', { index, expectedArgs: { voteId, voter: address, supports: VOTE_NAY_VALUE, stake: votingPower } })
      }
      assertEvent(tx, 'AttemptCastVoteAsDelegate', { expectedArgs: { voteId, delegate: delegate1 } })
      const votersFromEvent = getEventArgument(tx, 'AttemptCastVoteAsDelegate', 'voters')
      assertArraysEqualAsSets(eligibleDelegatedVotersAddresses, votersFromEvent)

      // Check voters' state
      const votersState = await voting.getVoterStateMultipleAtVote(voteId, eligibleDelegatedVotersAddresses)
      votersState.every((state) => {
        assert.equal(state, VOTER_STATE.DELEGATE_NAY.toString(), `voter should have 'delegateNay' state`)
      })

      // Check applied VP
      const vote = await voting.getVote(voteId)
      const votingPowerSum = eligibleDelegatedVoters.reduce(
        (sum, { votingPower }) => sum.add(votingPower),
        ZERO_BN
      )
      assertBn(vote.nay, votingPowerSum, 'nay should be sum of all VP')
    })

    it(`successful vote for single`, async () => {
      const voter = voters[0]
      const tx = await voting.attemptVoteFor(voteId, VOTE_NAY_VALUE, voter, { from: delegate1 })

      // Check amount of events
      assertAmountOfEvents(tx, 'CastVote', { expectedAmount: 1 })
      assertAmountOfEvents(tx, 'AttemptCastVoteAsDelegate', { expectedAmount: 1 })

      // Check events content
      assertEvent(tx, 'CastVote', { expectedArgs: { voteId, voter, supports: VOTE_NAY_VALUE, stake: votersBalances[voter] } })
      assertEvent(tx, 'AttemptCastVoteAsDelegate', { expectedArgs: { voteId, delegate: delegate1 } })
      const votersFromEvent = getEventArgument(tx, 'AttemptCastVoteAsDelegate', 'voters')
      assertArraysEqualAsSets(votersFromEvent, [voter])

      // Check voter's state
      assert.equal(await voting.getVoterState(voteId, voter), VOTER_STATE.DELEGATE_NAY, `voter should have 'delegateNay' state`)

      // Check applied VP
      const vote = await voting.getVote(voteId)
      assertBn(vote.yea, ZERO_BN, 'yea should be 0')
      assertBn(vote.nay, votersBalances[voter], `nay should be voter's VP`)
    })
  })

  context('various scenarios', () => {
    beforeEach(async () => {
      for (const voter of voters) {
        await token.generateTokens(voter, votersBalances[voter])
      }

      voteId = await startEmptyVote()
    })

    it(`a delegated voter can overwrite delegate's vote during the main phase`, async () => {
      const voter = voters[0]
      await voting.assignDelegate(delegate1, { from: voter })
      await voting.attemptVoteFor(voteId, VOTE_NAY_VALUE, voter, { from: delegate1 })

      let vote = await voting.getVote(voteId)
      const votedNayBeforeOverwrite = vote.nay
      assert.equal(await voting.getVoterState(voteId, voter), VOTER_STATE.DELEGATE_NAY)

      await voting.vote(voteId, VOTE_YEA_VALUE, false, { from: voter })

      vote = await voting.getVote(voteId)
      assertBn(vote.nay, ZERO_BN, 'Applied VP for the previous vote should be removed')
      assertBn(votedNayBeforeOverwrite, vote.yea, 'Applied VP should move to the overwritten option')
      assert.equal(await voting.getVoterState(voteId, voter), VOTER_STATE.YEA)

      // Check that delegate can't vote on behalf of the voter after the voter has voted
      await assertRevert(
        voting.attemptVoteFor(voteId, VOTE_NAY_VALUE, voter, { from: delegate1 }),
        ERRORS.VOTING_CAN_NOT_VOTE_FOR
      )
    })

    it(`a delegated voter can overwrite delegate's vote during the objection phase`, async () => {
      const voter = voters[0]
      await voting.assignDelegate(delegate1, { from: voter })

      // The delegate votes on behalf of the voter
      await voting.attemptVoteFor(voteId, VOTE_YEA_VALUE, voter, { from: delegate1 })
      let vote = await voting.getVote(voteId)
      const votedYeaBeforeOverwrite = vote.yea
      assert.equal(await voting.getVoterState(voteId, voter), VOTER_STATE.DELEGATE_YEA)

      // Fast-forward the vote to the objection phase
      await voting.mockIncreaseTime(VOTING_DURATION - OBJECTION_PHASE_DURATION)
      vote = await voting.getVote(voteId)
      assert.equal(vote.phase, VOTE_PHASE.OBJECTION)

      // The voter overwrites the delegate's vote
      await voting.vote(voteId, VOTE_NAY_VALUE, false, { from: voter })
      vote = await voting.getVote(voteId)
      assertBn(vote.yea, ZERO_BN, 'Applied VP for the previous vote should be removed')
      assertBn(votedYeaBeforeOverwrite, vote.nay, 'Applied VP should move to the overwritten option')
      assert.equal(await voting.getVoterState(voteId, voter), VOTER_STATE.NAY)
    })

    it('a delegate can vote for a voter that assigned them during the open vote', async () => {
      // Check for the main phase
      assert.equal((await voting.getVote(voteId)).phase, VOTE_PHASE.MAIN)

      const [voter1, voter2] = voters

      await voting.assignDelegate(delegate1, { from: voter1 })
      await voting.attemptVoteFor(voteId, VOTE_YEA_VALUE, voter1, { from: delegate1 })
      assert.equal(await voting.getVoterState(voteId, voter1), VOTER_STATE.DELEGATE_YEA)

      // Check for the objection phase
      await voting.mockIncreaseTime(VOTING_DURATION - OBJECTION_PHASE_DURATION)
      assert.equal((await voting.getVote(voteId)).phase, VOTE_PHASE.OBJECTION)

      await voting.assignDelegate(delegate1, { from: voter2 })
      await voting.attemptVoteFor(voteId, VOTE_NAY_VALUE, voter2, { from: delegate1 })
      assert.equal(await voting.getVoterState(voteId, voter2), VOTER_STATE.DELEGATE_NAY)
    })

    it(`a delegate can't vote for a voter that changed the delegate during the vote`, async () => {
      const voter = voters[0]
      await voting.assignDelegate(delegate1, { from: voter })
      await voting.attemptVoteFor(voteId, VOTE_YEA_VALUE, voter, { from: delegate1 })
      assert.equal(await voting.getVoterState(voteId, voter), VOTER_STATE.DELEGATE_YEA)

      await voting.assignDelegate(delegate2, { from: voter })

      // delegate1 tries to change their mind after being unassigned
      await assertRevert(
        voting.attemptVoteFor(voteId, VOTE_NAY_VALUE, voter, { from: delegate1 }),
        ERRORS.VOTING_CAN_NOT_VOTE_FOR
      )
    })

    it(`a delegate's vote applies only vote's snapshot VP, not current`, async () => {
      const votersSlice = voters.slice(0, 2)
      for (const voter of votersSlice) {
        await voting.assignDelegate(delegate1, { from: voter })
      }

      // Manipulate voting power of the delegated voters after the vote has started
      await token.generateTokens(votersSlice[0], bigExp(2, TOKEN_DECIMALS))
      await token.destroyTokens(votersSlice[1], bigExp(1, TOKEN_DECIMALS))

      await voting.attemptVoteForMultiple(voteId, VOTE_YEA_VALUE, votersSlice, { from: delegate1 })

      // Check if the delegate's vote applied the correct voting power
      const votersVotingPower = await voting.getVotingPowerMultipleAtVote(voteId, votersSlice)
      const votingPowerSum = getVotingPowerSum(votersVotingPower)
      const vote = await voting.getVote(voteId)
      assertBn(vote.yea, votingPowerSum, 'Vote should have the correct yea value')
    })

    it('a delegate can change their mind and re-vote for other option', async () => {
      const votersSlice = voters.slice(0, 2)
      for (const voter of votersSlice) {
        await voting.assignDelegate(delegate1, { from: voter })
      }

      await voting.attemptVoteForMultiple(voteId, VOTE_NAY_VALUE, votersSlice, { from: delegate1 })
      // Check the state after the first vote
      let votersState = await voting.getVoterStateMultipleAtVote(voteId, votersSlice)
      votersState.every((state) => {
        assert.equal(state, VOTER_STATE.DELEGATE_NAY, `voter should have 'delegateNay' state`)
      })
      let vote = await voting.getVote(voteId)
      const votersVotingPower = await voting.getVotingPowerMultipleAtVote(voteId, votersSlice)
      const votersVotingPowerSum = getVotingPowerSum(votersVotingPower)
      assertBn(vote.nay, votersVotingPowerSum)

      // Delegate changes their mind and votes for the other option
      await voting.attemptVoteForMultiple(voteId, VOTE_YEA_VALUE, votersSlice, { from: delegate1 })
      // Check the state after the second vote
      votersState = await voting.getVoterStateMultipleAtVote(voteId, votersSlice)
      votersState.every((state) => {
        assert.equal(state, VOTER_STATE.DELEGATE_YEA, `voter should have 'delegateYea' state`)
      })
      vote = await voting.getVote(voteId)
      assertBn(vote.yea, votersVotingPowerSum)
      assertBn(vote.nay, ZERO_BN)

      // Delegate changes their mind again and votes for the other option during the objection phase
      await voting.mockIncreaseTime(VOTING_DURATION - OBJECTION_PHASE_DURATION)
      vote = await voting.getVote(voteId)
      assert.equal(vote.phase, VOTE_PHASE.OBJECTION)

      await voting.attemptVoteForMultiple(voteId, VOTE_NAY_VALUE, votersSlice, { from: delegate1 })
      // Check the state after the third vote
      votersState = await voting.getVoterStateMultipleAtVote(voteId, votersSlice)
      votersState.every((state) => {
        assert.equal(state, VOTER_STATE.DELEGATE_NAY, `voter should have 'delegateNay' state`)
      })
      vote = await voting.getVote(voteId)
      assertBn(vote.nay, votersVotingPowerSum)
      assertBn(vote.yea, ZERO_BN)
    })

    it(`the new delegate can overwrite the old delegate's vote during the main phase`, async () => {
      for (const voter of voters) {
        await voting.assignDelegate(delegate1, { from: voter })
      }

      await voting.attemptVoteForMultiple(voteId, VOTE_YEA_VALUE, voters, { from: delegate1 })

      // Check the state after the first vote
      const votersState = await voting.getVoterStateMultipleAtVote(voteId, voters)
      assertArraysEqualAsSets(votersState, voters.map(() => VOTER_STATE.DELEGATE_YEA))
      let vote = await voting.getVote(voteId)
      const votersVotingPower = await voting.getVotingPowerMultipleAtVote(voteId, voters)
      const votersVotingPowerSum = getVotingPowerSum(votersVotingPower)
      assertBn(vote.yea, votersVotingPowerSum, 'Vote should have the correct yea value')

      // One of the voters changes their delegate
      const voter = voters[0]
      await voting.assignDelegate(delegate2, { from: voter })

      // The new delegate votes for the other option
      await voting.attemptVoteFor(voteId, VOTE_NAY_VALUE, voter, { from: delegate2 })
      const voterState = await voting.getVoterState(voteId, voter)
      assert.equal(voterState, VOTER_STATE.DELEGATE_NAY)
      vote = await voting.getVote(voteId)
      assertBn(vote.nay, votersBalances[voter])
      assertBn(vote.yea, votersVotingPowerSum.sub(votersBalances[voter]))
    })

    it(`the new delegate can overwrite the old delegate's vote during the objection phase`, async () => {
      for (const voter of voters) {
        await voting.assignDelegate(delegate1, { from: voter })
      }

      await voting.attemptVoteForMultiple(voteId, VOTE_YEA_VALUE, voters, { from: delegate1 })

      // Check the state after the first vote
      const votersState = await voting.getVoterStateMultipleAtVote(voteId, voters)
      assertArraysEqualAsSets(votersState, voters.map(() => VOTER_STATE.DELEGATE_YEA))
      let vote = await voting.getVote(voteId)
      const votersVotingPower = await voting.getVotingPowerMultipleAtVote(voteId, voters)
      const votersVotingPowerSum = getVotingPowerSum(votersVotingPower)
      assertBn(vote.yea, votersVotingPowerSum, 'Vote should have the correct yea value')

      // Fast-forward the vote to the objection phase
      await voting.mockIncreaseTime(VOTING_DURATION - OBJECTION_PHASE_DURATION)
      vote = await voting.getVote(voteId)
      assert.equal(vote.phase, VOTE_PHASE.OBJECTION)

      // One of the voters changes their delegate
      const voter = voters[0]
      await voting.assignDelegate(delegate2, { from: voter })

      // The new delegate votes for the other option
      await voting.attemptVoteFor(voteId, VOTE_NAY_VALUE, voter, { from: delegate2 })
      const voterState = await voting.getVoterState(voteId, voter)
      assert.equal(voterState, VOTER_STATE.DELEGATE_NAY)
      vote = await voting.getVote(voteId)
      assertBn(vote.nay, votersBalances[voter])
      assertBn(vote.yea, votersVotingPowerSum.sub(votersBalances[voter]))
    })

    it('A delegate can still vote after being spammed by malisious accounts', async () => {
      const [voter1, voter2] = voters.slice(0, 2)

      await voting.assignDelegate(delegate1, { from: voter1 })

      for (const holder of spamHolders) {
        await token.generateTokens(holder, bigExp(1, TOKEN_DECIMALS))
        await voting.assignDelegate(delegate1, { from: holder })
      }

      await voting.assignDelegate(delegate1, { from: voter2 })

      const delegatedVoters = await voting.getDelegatedVoters(delegate1, 0, 600)
      assertArraysEqualAsSets(delegatedVoters, [voter1, ...spamHolders, voter2])
      const delegatedVotersVotingPower = await voting.getVotingPowerMultipleAtVote(voteId, delegatedVoters)
      const delegatedVotersState = await voting.getVoterStateMultipleAtVote(voteId, delegatedVoters)

      const eligibleDelegatedVoters = []
      for (let i = 0; i < delegatedVoters.length; i++) {
        const votingPower = delegatedVotersVotingPower[i]
        const voterState = delegatedVotersState[i]
        if (votingPower.gt(ZERO_BN) && voterState !== VOTER_STATE.YEA && voterState !== VOTER_STATE.NAY) {
          eligibleDelegatedVoters.push(delegatedVoters[i])
        }
      }
      assertArraysEqualAsSets(eligibleDelegatedVoters, [voter1, voter2])

      await voting.attemptVoteForMultiple(voteId, VOTE_YEA_VALUE, eligibleDelegatedVoters, { from: delegate1 })
      const vote = await voting.getVote(voteId)
      const eligibleDelegatedVotersState = await voting.getVoterStateMultipleAtVote(voteId, eligibleDelegatedVoters)
      assertArraysEqualAsSets(eligibleDelegatedVotersState, eligibleDelegatedVoters.map(() => VOTER_STATE.DELEGATE_YEA))
      const eligibleDelegatedVotersVotingPower = await voting.getVotingPowerMultipleAtVote(voteId, eligibleDelegatedVoters)
      const eligibleDelegatedVotersVotingPowerSum = getVotingPowerSum(eligibleDelegatedVotersVotingPower)
      assertBn(vote.yea, eligibleDelegatedVotersVotingPowerSum)

    })
    .timeout(60_000)

    it(`a delegate can't overwrite if voter has voted first`, async () => {
      const votersSlice = voters.slice(0, 2)
      for (const voter of votersSlice) {
        await voting.assignDelegate(delegate1, { from: voter })
      }

      await voting.vote(voteId, VOTE_NAY_VALUE, false, { from: votersSlice[0] })

      await voting.attemptVoteForMultiple(voteId, VOTE_YEA_VALUE, votersSlice, { from: delegate1 })

      const selfVoterState = await voting.getVoterState(voteId, votersSlice[0])
      assert.equal(selfVoterState, VOTER_STATE.NAY)
    })

    it(`a delegated voter can't overwrite the "nay" vote of the delegate with "yea" during the objection phase`, async () => {
      const voter = voters[0]
      await voting.assignDelegate(delegate1, { from: voter })

      await voting.attemptVoteFor(voteId, VOTE_NAY_VALUE, voter, { from: delegate1 })

      // Set the time to the start of the objection phase
      await voting.mockIncreaseTime(VOTING_DURATION - OBJECTION_PHASE_DURATION)
      const { phase } = await voting.getVote(voteId)
      assert.equal(phase, VOTE_PHASE.OBJECTION)

      // Can not vote "yea" during the objection phase
      await assertRevert(
        voting.vote(voteId, VOTE_YEA_VALUE, false, { from: voter }),
        ERRORS.VOTING_CAN_NOT_VOTE
      )
    })

  })

  context.skip('Gas estimation tests (should be skipped)', () => {
    beforeEach(async () => {
      for (const holder of spamHolders) {
        await token.generateTokens(holder, bigExp(1, TOKEN_DECIMALS))
        await voting.assignDelegate(delegate1, { from: holder })
      }

      voteId = await startEmptyVote()
    })

    it(`voting without delegation`, async () => {
      const voter = spamHolders[0]
      const tx = await voting.vote(voteId, true, false, { from: voter })
      console.log('Gas used for a voting without delegation:', tx.receipt.gasUsed)
    })

    it(`voting for 1`, async () => {
      const voter = spamHolders[0]
      const tx = await voting.attemptVoteFor(voteId, false, voter, { from: delegate1 })
      console.log('Gas used for voting for 1:', tx.receipt.gasUsed)
    })

    it(`voting for 10`, async () => {
      const votersSlice = spamHolders.slice(0, 10)
      const tx = await voting.attemptVoteForMultiple(voteId, false, votersSlice, { from: delegate1 })
      console.log('Gas used for voting for 10:', tx.receipt.gasUsed)
    })

    it(`voting for 100`, async () => {
      const votersSlice = spamHolders.slice(0, 100)
      const tx = await voting.attemptVoteForMultiple(voteId, false, votersSlice, { from: delegate1 })
      console.log('Gas used for voting for 100:', tx.receipt.gasUsed)
    })

  })
})
