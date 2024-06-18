const ERRORS = require('./helpers/errors')
const assertArraysEqualAsSets = require('./helpers/assertArrayAsSets')
const { assertBn, assertRevert, assertAmountOfEvents, assertEvent } = require('@aragon/contract-helpers-test/src/asserts')
const { pct16, bn, bigExp, getEventArgument, ZERO_ADDRESS } = require('@aragon/contract-helpers-test')
const { newDao, installNewApp, encodeCallScript, ANY_ENTITY, EMPTY_CALLS_SCRIPT } = require('@aragon/contract-helpers-test/src/aragon-os')
const { assert } = require('chai')
const { getStorageAt, setStorageAt, impersonateAccount } = require("@nomicfoundation/hardhat-network-helpers")

const Voting = artifacts.require('VotingMock')

const MiniMeToken = artifacts.require('MiniMeToken')
const ExecutionTarget = artifacts.require('ExecutionTarget')

const createdVoteId = receipt => getEventArgument(receipt, 'StartVote', 'voteId')

const VOTER_STATE = ['ABSENT', 'YEA', 'NAY', 'DELEGATE_YEA', 'DELEGATE_NAY'].reduce((state, key, index) => {
  state[key] = index;
  return state;
}, {})

contract('Voting App (delegation)', ([root, holder1, holder2, holder20, holder29, holder51, delegate1, delegate2, nonHolder, ...spamHolders]) => {
  let votingBase, voting, token, executionTarget, aclP
  let CREATE_VOTES_ROLE, MODIFY_SUPPORT_ROLE, MODIFY_QUORUM_ROLE, UNSAFELY_MODIFY_VOTE_TIME_ROLE

  const NOW = 1
  const mainPhase = 700
  const objectionPhase = 300
  const votingDuration = mainPhase + objectionPhase

  const APP_ID = '0x1234123412341234123412341234123412341234123412341234123412341234'

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
    aclP = acl
  })

  context('simple delegation scenarios', () => {
    const neededSupport = pct16(50)
    const minimumAcceptanceQuorum = pct16(20)
    const decimals = 18

    const MAIN_PHASE = 0
    const OBJECTION_PHASE = 1

    const LDO1 = bigExp(1, decimals)
    const LDO20 = bigExp(20, decimals)
    const LDO29 = bigExp(29, decimals)
    const LDO51 = bigExp(51, decimals)
    const LDO3 = bigExp(3, decimals)
    const initBalance = {
      [holder1]: LDO1,
      [holder20]: LDO20,
      [holder29]: LDO29,
      [holder51]: LDO51,
    }

    const assignDelegate = async (delegate, holder ) => {
      const tx = await voting.assignDelegate(delegate, {from: holder})
      assertEvent(tx, 'AssignDelegate', {
        expectedArgs: {voter: holder, assignedDelegate: delegate}
      })
      assertAmountOfEvents(tx, 'AssignDelegate', {expectedAmount: 1})
    }
    const attemptVoteFor = async (voteId, supports, holder, delegate) => {
      const tx = await voting.attemptVoteFor(voteId, supports, holder, {from: delegate})
      assertEvent(tx, 'CastVote', {
        expectedArgs: {voteId: voteId, voter: holder, supports, stake: initBalance[holder]}
      })
      assertEvent(tx, 'AttemptCastVoteAsDelegate', { expectedArgs: {voteId, delegate} })
      const votersFromEvent = getEventArgument(tx, 'AttemptCastVoteAsDelegate', 'voters')
      assertArraysEqualAsSets([holder], votersFromEvent)
      assertAmountOfEvents(tx, 'CastVote', {expectedAmount: 1})
      assertAmountOfEvents(tx, 'AttemptCastVoteAsDelegate', {expectedAmount: 1})
    }
    const attemptVoteForMultiple = async (voteId, supports, holders, delegate) => {
      const tx = await voting.attemptVoteForMultiple(voteId, supports, holders, {from: delegate})

      for (const index of Object.keys(holders)){
        const holder = holders[index]
        let stake
        if (initBalance[holder]) {
          stake = initBalance[holder]
        }
        if (!stake && spamHolders.includes(holder)) {
          stake = LDO3
        }
        assertEvent(tx, 'CastVote', {
          index,
          expectedArgs: {voteId, voter: holder, supports, stake}
        })
      }
      assertEvent(tx, 'AttemptCastVoteAsDelegate', { expectedArgs: {voteId, delegate} })
      const votersFromEvent = getEventArgument(tx, 'AttemptCastVoteAsDelegate', 'voters')
      assertArraysEqualAsSets(holders, votersFromEvent)
      assertAmountOfEvents(tx, 'CastVote', {expectedAmount: holders.length})
      assertAmountOfEvents(tx, 'AttemptCastVoteAsDelegate', {expectedAmount: 1})
    }
    const vote = async (voteId, supports, exec, holder) => {
      const tx = await voting.vote(voteId, supports, exec, {from: holder})
      assertEvent(tx, 'CastVote', {
        expectedArgs: {voteId: voteId, voter: holder, supports, stake: initBalance[holder]}
      })
      assertAmountOfEvents(tx, 'CastVote', {expectedAmount: 1})
    }
    const verifyVoteYN = async (voteId, yes, no) => {
      const { yea, nay } = await voting.getVote(voteId)

      assert.equal(yea.toString(), yes.toString())
      assert.equal(nay.toString(), no.toString())
    }

    beforeEach(async () => {
      token = await MiniMeToken.new(ZERO_ADDRESS, ZERO_ADDRESS, 0, 'n', decimals, 'n', true) // empty parameters minime
      for (const [holder, balance] of Object.entries(initBalance)){
        await token.generateTokens(holder, balance)
      }

      await voting.initialize(token.address, neededSupport, minimumAcceptanceQuorum, votingDuration, objectionPhase)

      executionTarget = await ExecutionTarget.new()
    })

    it(`voter can't set the zero address as a delegate`, async () => {
      await assertRevert(
        voting.assignDelegate(ZERO_ADDRESS, {from: holder29}),
        ERRORS.VOTING_ZERO_ADDRESS_PASSED
      )
    })

    it(`voter can't assign themself as a delegate`, async () => {
      await assertRevert(
        voting.assignDelegate(holder29, {from: holder29}),
        ERRORS.VOTING_SELF_DELEGATE
      )
    })

    it(`voter can't assign their current delegate as a delegate`, async () => {
      await voting.assignDelegate(delegate1, {from: holder29})
      await assertRevert(
        voting.assignDelegate(delegate1, {from: holder29}),
        ERRORS.VOTING_DELEGATE_SAME_AS_PREV
      )
    })

    it(`voter can't unassign their delegate if they wasn't assigned before`, async () => {
      await assertRevert(
        voting.unassignDelegate({from: holder29}),
        ERRORS.VOTING_DELEGATE_NOT_SET
      )
    })

    it('voter can set delegate', async () => {
      let delegatedVoters = await voting.getDelegatedVoters(delegate1, 0, 1)
      assert.equal(delegatedVoters.length, 0, 'delegate1 should not be a delegate of anyone')

      const tx = await voting.assignDelegate(delegate1, {from: holder29})
      assertEvent(tx, 'AssignDelegate', {
        expectedArgs: {voter: holder29, assignedDelegate: delegate1}
      })
      assertAmountOfEvents(tx, 'AssignDelegate', {expectedAmount: 1})

      const delegate = await voting.getDelegate(holder29)
      assert.equal(delegate, delegate1, 'holder29 should have delegate1 as a delegate')

      delegatedVoters = await voting.getDelegatedVoters(delegate1, 0, 1)
      assertArraysEqualAsSets(delegatedVoters, [holder29], 'delegate1 should be a delegate of holder29')
    })

    it(`assignment fails if delegatedVoters array is overflown`, async () => {
      const arrayLengthSlotIndex = 5
      const paddedAddress = ethers.utils.hexZeroPad(delegate1, 32)
      const paddedSlot = ethers.utils.hexZeroPad(arrayLengthSlotIndex, 32)
      const arrayLengthSlot = ethers.utils.solidityKeccak256(['address', 'uint256'], [paddedAddress, paddedSlot])

      // Check that slot index is correct
      let storage = await getStorageAt(voting.address, arrayLengthSlot)
      assert(ethers.BigNumber.from(storage).eq(0), 'delegatedVoters array length should be 0')

      await voting.assignDelegate(delegate1, {from: holder29})
      storage = await getStorageAt(voting.address, arrayLengthSlot)
      assert(ethers.BigNumber.from(storage).eq(1), 'delegatedVoters array length should be 1 after assignment')

      // Update slot value to max uint96
      const uint96Max = ethers.BigNumber.from(2).pow(96)
      await setStorageAt(voting.address, arrayLengthSlot, uint96Max)

      // Check that revert is thrown when trying to assign a delegate
      await assertRevert(
        voting.assignDelegate(delegate1, {from: holder51}),
        ERRORS.VOTING_MAX_DELEGATED_VOTERS_REACHED
      )
    })

    it('voter can remove delegate', async () => {
      let delegatedVoters = await voting.getDelegatedVoters(delegate1, 0, 1)
      assert.equal(delegatedVoters.length, 0, 'delegate1 should not be a delegate of anyone')

      await voting.assignDelegate(delegate1, {from: holder29})

      delegatedVoters = await voting.getDelegatedVoters(delegate1, 0, 1)
      assertArraysEqualAsSets(delegatedVoters, [holder29], 'delegate1 should be a delegate of holder29')

      const tx = await voting.unassignDelegate({from: holder29})
      assertEvent(tx, 'UnassignDelegate', {
        expectedArgs: {voter: holder29, unassignedDelegate: delegate1}
      })
      assertAmountOfEvents(tx, 'UnassignDelegate', {expectedAmount: 1})
      delegatedVoters = await voting.getDelegatedVoters(delegate1, 0, 1)
      assertArraysEqualAsSets(delegatedVoters, [], 'delegate1 should not be a delegate of anyone')
    })

    it('voters can remove delegate', async () => {
      let delegatedVoters = await voting.getDelegatedVoters(delegate1, 0, 1)
      assert.equal(delegatedVoters.length, 0, 'delegate1 should not be a delegate of anyone')

      await voting.assignDelegate(delegate1, {from: holder20})
      await voting.assignDelegate(delegate1, {from: holder29})
      await voting.assignDelegate(delegate1, {from: holder51})

      const tx1 = await voting.unassignDelegate({from: holder29})
      assertEvent(tx1, 'UnassignDelegate', {
        expectedArgs: {voter: holder29, unassignedDelegate: delegate1}
      })
      assertAmountOfEvents(tx1, 'UnassignDelegate', {expectedAmount: 1})
      delegatedVoters = await voting.getDelegatedVoters(delegate1, 0, 5)
      assertArraysEqualAsSets(delegatedVoters, [holder20, holder51], 'delegate1 have holder20 and holder51 as a delegated voters')

      const tx2 = await voting.unassignDelegate({from: holder51})
      assertEvent(tx2, 'UnassignDelegate', {
        expectedArgs: {voter: holder51, unassignedDelegate: delegate1}
      })
      assertAmountOfEvents(tx2, 'UnassignDelegate', {expectedAmount: 1})
      delegatedVoters = await voting.getDelegatedVoters(delegate1, 0, 1)
      assertArraysEqualAsSets(delegatedVoters, [holder20], 'delegate1 have only holder20 as a delegated voter')
    })

    it('voter can change delegate', async () => {
      let delegatedVoters = await voting.getDelegatedVoters(delegate1, 0, 1)
      assert.equal(delegatedVoters.length, 0, 'delegate1 should not be a delegate of anyone')
      delegatedVoters = await voting.getDelegatedVoters(delegate2, 0, 1)
      assert.equal(delegatedVoters.length, 0, 'delegate2 should not be a delegate of anyone')

      await voting.assignDelegate(delegate1, {from: holder29})
      await voting.assignDelegate(delegate2, {from: holder51})

      await voting.assignDelegate(delegate2, {from: holder29})

      const delegatedVotersDelegate1 = await voting.getDelegatedVoters(delegate1, 0, 1)
      assertArraysEqualAsSets(delegatedVotersDelegate1, [], 'delegate1 should not be a delegate of anyone')
      const delegatedVotersDelegate2 = await voting.getDelegatedVoters(delegate2, 0, 2)
      assertArraysEqualAsSets(delegatedVotersDelegate2, [holder29, holder51], 'delegate2 should be a delegate of holder29 and holder51')
    })

    it('delegate can manage several voters', async () => {
      let delegatedVoters = await voting.getDelegatedVoters(delegate1, 0, 1)
      assert.equal(delegatedVoters.length, 0, 'delegate1 should not be a delegate of anyone')

      const tx1 = await voting.assignDelegate(delegate1, {from: holder29})
      assertEvent(tx1, 'AssignDelegate', {
        expectedArgs: {voter: holder29, assignedDelegate: delegate1}
      })
      assertAmountOfEvents(tx1, 'AssignDelegate', {expectedAmount: 1})

      const tx2 = await voting.assignDelegate(delegate1, {from: holder51})
      assertEvent(tx2, 'AssignDelegate', {
        expectedArgs: {voter: holder51, assignedDelegate: delegate1}
      })
      assertAmountOfEvents(tx2, 'AssignDelegate', {expectedAmount: 1})

      delegatedVoters = await voting.getDelegatedVoters(delegate1, 0, 2)
      assertArraysEqualAsSets(delegatedVoters, [holder29, holder51], 'delegate1 should be a delegate of holder29 and holder51')
    })

    // Multiple voters with non-zero balances of governance token are delegating their voting
    // power to a single delegate. The voting starts and the delegate is voting for all of them - first
    // they get the full list of voters with their balance snapshot and vote states of the given voting,
    // then they vote for that list.
    it('delegate can manage several voters and vote for all (voteFor)', async () => {
      const delegateList = [ [delegate1, holder1], [delegate1, holder20] ]

      for (const [delegate, holder] of delegateList) {
        await assignDelegate(delegate, holder)
      }

      const voteId = createdVoteId(await voting.newVote(EMPTY_CALLS_SCRIPT, 'metadata'))

      const delegatedVoters = await voting.getDelegatedVoters(delegate1, 0, 3)
      assertArraysEqualAsSets(delegatedVoters, [holder1, holder20])

      for (const holder of delegatedVoters) {
        await attemptVoteFor(voteId, false, holder, delegate1)
      }

      await verifyVoteYN(voteId, 0, LDO1.add(LDO20))
      const voterState = await voting.getVoterStateMultipleAtVote(voteId, delegatedVoters)
      assertArraysEqualAsSets(voterState, [VOTER_STATE.DELEGATE_NAY.toString()])
    })

    // Multiple voters with non-zero balances of governance token are delegating their voting
    // power to a single delegate. The voting starts and the delegate is voting for all of them - first
    // they get the full list of voters with their balance snapshot and vote states of the given voting,
    // then they vote for that list.
    it('delegate can manage several voters and vote all (voteForMulti)', async () => {
      const delegateList= [ [delegate2, holder29], [delegate2, holder51] ]
      for (const [delegate, holder] of delegateList) {
        await assignDelegate(delegate, holder)
      }

      const voteId = createdVoteId(await voting.newVote(EMPTY_CALLS_SCRIPT, 'metadata'))

      const delegatedVoters = await voting.getDelegatedVoters(delegate2, 0, 3)

      assertArraysEqualAsSets(delegatedVoters, [holder29,holder51])

      await attemptVoteForMultiple(voteId, true, delegatedVoters, delegate2)
      await verifyVoteYN(voteId, LDO51.add(LDO29), 0)

      const voterState = await voting.getVoterStateMultipleAtVote(voteId, delegatedVoters)
      assertArraysEqualAsSets(voterState, [VOTER_STATE.DELEGATE_YEA.toString()])
    })

    // Multiple voters with non-zero balances of governance token are delegating their voting
    // power to a single delegate. The voting starts and the delegate is voting for one of them.
    it('delegate can manage several voters and vote for first (voteFor)', async () => {
      const delegateList= [ [delegate1, holder1], [delegate1, holder20] ]

      for (const [delegate, holder] of delegateList) {
        await assignDelegate(delegate, holder)
      }

      const voteId = createdVoteId(await voting.newVote(EMPTY_CALLS_SCRIPT, 'metadata'))

      const delegatedVoters = await voting.getDelegatedVoters(delegate1, 0, 3)
      assertArraysEqualAsSets(delegatedVoters, [holder1, holder20])

      await attemptVoteFor(voteId, false, holder1, delegate1)

      await verifyVoteYN(voteId, 0, LDO1)

      const voterStateHolder1 = await voting.getVoterStateMultipleAtVote(voteId, [holder1])
      const voterStateHolder20 = await voting.getVoterStateMultipleAtVote(voteId, [holder20])

      assertArraysEqualAsSets(voterStateHolder1, [VOTER_STATE.DELEGATE_NAY.toString()])
      assertArraysEqualAsSets(voterStateHolder20, [VOTER_STATE.ABSENT.toString()])
    })

    // Multiple voters with non-zero balances of governance token are delegating their voting
    // power to a single delegate. The voting starts and the delegate is voting for one of them.
    it('delegate can manage several voters and vote for first (voteForMulti)', async () => {
      const delegateList= [ [delegate2, holder29], [delegate2, holder51] ]
      for (const [delegate, holder] of delegateList) {
        assignDelegate(delegate, holder)
      }

      const voteId = createdVoteId(await voting.newVote(EMPTY_CALLS_SCRIPT, 'metadata'))

      const delegatedVoters = await voting.getDelegatedVoters(delegate2, 0, 3)

      assertArraysEqualAsSets(delegatedVoters, [ holder29, holder51 ])

      await attemptVoteForMultiple(voteId, true, [holder29], delegate2)

      await verifyVoteYN(voteId, LDO29, 0)

      const voterStateHolder29 = await voting.getVoterStateMultipleAtVote(voteId, [holder29])
      const voterStateHolder51 = await voting.getVoterStateMultipleAtVote(voteId, [holder51])

      assertArraysEqualAsSets(voterStateHolder29, [VOTER_STATE.DELEGATE_YEA.toString()])
      assertArraysEqualAsSets(voterStateHolder51, [VOTER_STATE.ABSENT.toString()])
    })

    // A delegated voter can overwrite a delegate's vote.
    it('delegated voter can overwrite a delegates vote (voteFor)', async () => {
      const [ delegate, holder] = [ delegate1, holder1 ]

      assignDelegate(delegate, holder)

      const voteId = createdVoteId(await voting.newVote(EMPTY_CALLS_SCRIPT, 'metadata'))

      const delegatedVoters = await voting.getDelegatedVoters(delegate1, 0, 3)
      assertArraysEqualAsSets(delegatedVoters, [ holder1 ])

      const supports = false
      await attemptVoteFor(voteId, supports, holder, delegate1)

      const delegatedVoterState = await voting.getVoterStateMultipleAtVote(voteId, [holder])
      assertArraysEqualAsSets(delegatedVoterState, [VOTER_STATE.DELEGATE_NAY.toString()])

      await vote( voteId, !supports, false, holder)

      await verifyVoteYN(voteId, LDO1, 0)

      const voterState = await voting.getVoterStateMultipleAtVote(voteId, [holder])
      assertArraysEqualAsSets(voterState, [VOTER_STATE.YEA.toString()])
    })

    // A delegated voter can overwrite a delegate's vote.
    it('delegated voter can overwrite a delegates vote (voteForMulti)', async () => {
      const [ delegate, holder] = [ delegate2, holder29 ]

      await assignDelegate(delegate, holder)

      const voteId = createdVoteId(await voting.newVote(EMPTY_CALLS_SCRIPT, 'metadata'))

      const delegatedVoters = await voting.getDelegatedVoters(delegate2, 0, 3)
      assertArraysEqualAsSets(delegatedVoters, [holder29])

      const supports = true
      await attemptVoteForMultiple(voteId, supports, [holder], delegate2)
      const delegatedVoterState = await voting.getVoterStateMultipleAtVote(voteId, [holder])
      assertArraysEqualAsSets(delegatedVoterState, [VOTER_STATE.DELEGATE_YEA.toString()])

      await vote(voteId, !supports, false, holder)

      await verifyVoteYN(voteId, 0 , LDO29)

      const voterState = await voting.getVoterStateMultipleAtVote(voteId, [holder])
      assertArraysEqualAsSets(voterState, [VOTER_STATE.NAY.toString()])
    })

    // A delegate can vote for a voter that delegated them their voting power during the active
    // phase of the vote.
    it('delegate can vote for a voter that delegated them their voting power during the active phase (voteFor)', async () => {
      const [ delegate, holder] = [ delegate2, holder1 ]

      await assignDelegate(delegate, holder)

      const voteId = createdVoteId(await voting.newVote(EMPTY_CALLS_SCRIPT, 'metadata'))
      const { phase } = await voting.getVote(voteId)
      assert.equal(phase, MAIN_PHASE)

      await assignDelegate(delegate1, holder)
      const delegatedVoters = await voting.getDelegatedVoters(delegate1, 0, 3)
      assertArraysEqualAsSets(delegatedVoters, [ holder1 ])

      await attemptVoteFor(voteId, false, holder, delegate1)

      await verifyVoteYN(voteId, 0, LDO1)

      const voterState = await voting.getVoterStateMultipleAtVote(voteId, [holder])
      assertArraysEqualAsSets(voterState, [VOTER_STATE.DELEGATE_NAY.toString()])
    })

    // A delegate can vote for a voter that delegated them their voting power during the active
    // phase of the vote.
    it('delegate can vote for a voter that delegated them their voting power during the active phase (voteForMulti)', async () => {
      const [ delegate, holder] = [ delegate1, holder29 ]

      await assignDelegate(delegate, holder)

      const voteId = createdVoteId(await voting.newVote(EMPTY_CALLS_SCRIPT, 'metadata'))
      const { phase } = await voting.getVote(voteId)
      assert.equal(phase, MAIN_PHASE)

      await assignDelegate(delegate2, holder)
      const delegatedVoters = await voting.getDelegatedVoters(delegate2, 0, 3)
      assertArraysEqualAsSets(delegatedVoters, [holder29])

      await attemptVoteForMultiple(voteId, true, [holder], delegate2)

      await verifyVoteYN(voteId, LDO29, 0)

      const voterState = await voting.getVoterStateMultipleAtVote(voteId, [holder])
      assertArraysEqualAsSets(voterState, [VOTER_STATE.DELEGATE_YEA.toString()])
    })

    // A delegate can't vote for a voter that acquired voting power during the active phase of the vote.
    it('delegate cant vote for a voter that acquired voting power during the active phase of the vote (voteFor)', async () => {
      const [ delegate, holder] = [ delegate1, holder1 ]

      await assignDelegate(delegate, holder)

      const voteId = createdVoteId(await voting.newVote(EMPTY_CALLS_SCRIPT, 'metadata'))
      const { phase } = await voting.getVote(voteId)
      assert.equal(phase, MAIN_PHASE)

      await assignDelegate(delegate2,  holder)
      const delegatedVoters = await voting.getDelegatedVoters(delegate1, 0, 3)
      assertArraysEqualAsSets(delegatedVoters, [ ])

      await assertRevert(voting.attemptVoteFor(voteId, false, holder, {from: delegate1}), ERRORS.VOTING_CAN_NOT_VOTE_FOR)
    })

    // A delegate can't vote for a voter that acquired voting power during the active phase of the vote.
    it('delegate cant vote for a voter that acquired voting power during the active phase of the vote (voteForMulti)', async () => {
      const [ delegate, holder] = [ delegate2, holder29 ]

      await assignDelegate(delegate, holder)

      const voteId = createdVoteId(await voting.newVote(EMPTY_CALLS_SCRIPT, 'metadata'))
      const { phase } = await voting.getVote(voteId)
      assert.equal(phase, MAIN_PHASE)

      await assignDelegate(delegate1, holder)
      const delegatedVoters = await voting.getDelegatedVoters(delegate2, 0, 3)
      assertArraysEqualAsSets(delegatedVoters, [])

      await assertRevert(voting.attemptVoteForMultiple(voteId, true, [holder], {from: delegate2}), ERRORS.VOTING_CAN_NOT_VOTE_FOR)

    })

    // If a delegated voter lost or gain some voting power after the start of the vote, a delegate
    // would still apply the full voting power of the delegated voter (at the vote's snapshot)
    it('delegate vote by snapshot vp not current (voteFor)', async () => {
      const delegateList= [ [delegate1, holder1], [delegate1, holder20] ]

      for (const [delegate, holder] of delegateList) {
        await assignDelegate(delegate, holder)
      }

      const voteId = createdVoteId(await voting.newVote(EMPTY_CALLS_SCRIPT, 'metadata'))

      await token.generateTokens(holder1, bigExp(2, decimals))
      await token.destroyTokens(holder20, bigExp(5, decimals))

      const delegatedVoters = await voting.getDelegatedVoters(delegate1, 0, 3)
      assertArraysEqualAsSets(delegatedVoters, [holder1,holder20])

      for (const holder of delegatedVoters) {
        await attemptVoteFor(voteId, false, holder, delegate1)
      }
      await verifyVoteYN(voteId, 0, LDO1.add(LDO20))

      const voterState = await voting.getVoterStateMultipleAtVote(voteId, delegatedVoters)
      assertArraysEqualAsSets(voterState, [VOTER_STATE.DELEGATE_NAY.toString()])
    })

    // If a delegated voter lost or gain some voting power after the start of the vote, a delegate
    // would still apply the full voting power of the delegated voter (at the vote's snapshot)
    it('delegate vote by snapshot vp not current (voteForMulti)', async () => {
      const delegateList= [ [delegate2, holder29], [delegate2, holder51] ]
      for (const [delegate, holder] of delegateList) {
        await assignDelegate(delegate, holder)
      }

      const voteId = createdVoteId(await voting.newVote(EMPTY_CALLS_SCRIPT, 'metadata'))

      await token.generateTokens(holder29, bigExp(2, decimals))
      await token.destroyTokens(holder51, bigExp(5, decimals))

      const delegatedVoters = await voting.getDelegatedVoters(delegate2, 0, 3)
      assertArraysEqualAsSets(delegatedVoters, [holder29,holder51])

      await attemptVoteForMultiple(voteId, true, delegatedVoters, delegate2)
      await verifyVoteYN(voteId, LDO51.add(LDO29), 0)

      const voterState = await voting.getVoterStateMultipleAtVote(voteId, delegatedVoters)
      assertArraysEqualAsSets(voterState, [VOTER_STATE.DELEGATE_YEA.toString()])
    })

    // A delegate can vote for all their delegated voters even if delegate voted for them before
    // for different option (change mind)
    it('delegate change mind (voteFor)', async () => {
      const delegateList = [[delegate1, holder1], [delegate1, holder20]]

      for (const [delegate, holder] of delegateList) {
        await assignDelegate(delegate, holder)
      }

      const voteId = createdVoteId(await voting.newVote(EMPTY_CALLS_SCRIPT, 'metadata'))

      const delegatedVoters = await voting.getDelegatedVoters(delegate1, 0, 3)

      assertArraysEqualAsSets(delegatedVoters, [holder1, holder20])

      for (const holder of delegatedVoters) {
        await attemptVoteFor(voteId, false, holder, delegate1)
      }
      await verifyVoteYN(voteId,0, LDO1.add(LDO20))

      for (const holder of delegatedVoters) {
        await attemptVoteFor(voteId, true, holder, delegate1)
      }
      await verifyVoteYN(voteId, LDO1.add(LDO20), 0)

      const voterState = await voting.getVoterStateMultipleAtVote(voteId, delegatedVoters)
      assertArraysEqualAsSets(voterState, [VOTER_STATE.DELEGATE_YEA.toString()])
    })

    // A delegate can vote for all their delegated voters even if delegate voted for them before
    // for different option (change mind)
    it('delegate change mind (voteForMulti)', async () => {
      const delegateList= [ [delegate2, holder29], [delegate2, holder51] ]
      for (const [delegate, holder] of delegateList) {
        await assignDelegate(delegate, holder)
      }

      const voteId = createdVoteId(await voting.newVote(EMPTY_CALLS_SCRIPT, 'metadata'))

      const delegatedVoters = await voting.getDelegatedVoters(delegate2, 0, 3)
      assertArraysEqualAsSets(delegatedVoters, [holder29,holder51])


      await attemptVoteForMultiple(voteId, true, delegatedVoters, delegate2)
      await verifyVoteYN(voteId, LDO51.add(LDO29), 0)

      await attemptVoteForMultiple(voteId, false, delegatedVoters, delegate2)
      await verifyVoteYN(voteId, 0, LDO51.add(LDO29))

      const voterState = await voting.getVoterStateMultipleAtVote(voteId, delegatedVoters)
      assertArraysEqualAsSets(voterState, [VOTER_STATE.DELEGATE_NAY.toString()])
    })

    // A delegate can vote for all their delegated voters even if delegate voted for them before
    // for "no" option during the objection phase.(change mind)
    it('delegate vote "yes" in main phase, delegate vote "no" in objection (voteFor)', async () => {
      const delegateList = [[delegate1, holder1], [delegate1, holder20]]

      for (const [delegate, holder] of delegateList) {
        await assignDelegate(delegate, holder)
      }

      const voteId = createdVoteId(await voting.newVote(EMPTY_CALLS_SCRIPT, 'metadata'))

      const delegatedVoters = await voting.getDelegatedVoters(delegate1, 0, 3)
      assertArraysEqualAsSets(delegatedVoters, [holder1, holder20])

      for (const holder of delegatedVoters) {
        await attemptVoteFor(voteId, true, holder, delegate1)
      }

      await voting.mockIncreaseTime(votingDuration - objectionPhase)
      await verifyVoteYN(voteId, LDO1.add(LDO20), 0)

      const { phase } = await voting.getVote(voteId)
      assert.equal(phase, OBJECTION_PHASE)

      for (const holder of delegatedVoters) {
        await attemptVoteFor(voteId, false, holder, delegate1)
      }
      await verifyVoteYN(voteId, 0, LDO1.add(LDO20))

      const voterState = await voting.getVoterStateMultipleAtVote(voteId, delegatedVoters)
      assertArraysEqualAsSets(voterState, [VOTER_STATE.DELEGATE_NAY.toString()])
    })

    // A delegate can vote for all their delegated voters even if delegate voted for them before
    // for "no" option during the objection phase.(change mind)
    it('delegate vote "yes" in main phase, delegate vote "no" in objection (voteForMulti)', async () => {
      const delegateList= [ [delegate2, holder29], [delegate2, holder51] ]
      for (const [delegate, holder] of delegateList) {
        await assignDelegate(delegate, holder)
      }

      const voteId = createdVoteId(await voting.newVote(EMPTY_CALLS_SCRIPT, 'metadata'))

      const delegatedVoters = await voting.getDelegatedVoters(delegate2, 0, 3)
      assertArraysEqualAsSets(delegatedVoters, [holder29,holder51])

      await attemptVoteForMultiple(voteId, true, delegatedVoters, delegate2)

      await voting.mockIncreaseTime(votingDuration - objectionPhase)
      await verifyVoteYN(voteId, LDO51.add(LDO29), 0)

      const { phase } = await voting.getVote(voteId)
      assert.equal(phase, OBJECTION_PHASE)

      await attemptVoteForMultiple(voteId, false, delegatedVoters, delegate2)

      await verifyVoteYN(voteId, 0, LDO51.add(LDO29))

      const voterState = await voting.getVoterStateMultipleAtVote(voteId, delegatedVoters)
      assertArraysEqualAsSets(voterState, [VOTER_STATE.DELEGATE_NAY.toString()])
    })

    // A new delegate can vote "no" in objection phase for all their delegated voters
    // even if old delegate voted for "yes" them before
    it('delegate vote "yes" in main phase, new delegate vote "no" in objection (voteFor)', async () => {
      const delegateList = [[delegate1, holder1], [delegate1, holder20]]

      for (const [delegate, holder] of delegateList) {
        await assignDelegate(delegate, holder)
      }

      const voteId = createdVoteId(await voting.newVote(EMPTY_CALLS_SCRIPT, 'metadata'))

      const delegatedVoters = await voting.getDelegatedVoters(delegate1, 0, 3)
      assertArraysEqualAsSets(delegatedVoters, [holder1, holder20])

      for (const holder of delegatedVoters) {
        await attemptVoteFor(voteId, true, holder, delegate1)
      }

      await voting.mockIncreaseTime(votingDuration - objectionPhase)
      await verifyVoteYN(voteId, LDO1.add(LDO20), 0)

      const { phase } = await voting.getVote(voteId)
      assert.equal(phase, OBJECTION_PHASE)

      const objectorList = [[delegate2, holder1], [delegate2, holder20]]

      for (const [delegate, holder] of objectorList) {
        await assignDelegate(delegate, holder)
      }

      for (const [ delegate , holder] of objectorList) {
        await attemptVoteFor(voteId, false, holder, delegate)
      }
      await verifyVoteYN(voteId, 0, LDO1.add(LDO20))

      const voterState = await voting.getVoterStateMultipleAtVote(voteId, delegatedVoters)
      assertArraysEqualAsSets(voterState, [VOTER_STATE.DELEGATE_NAY.toString()])
    })

    // A new delegate can vote "no" in objection phase for all their delegated voters
    // even if old delegate voted for "yes" them before
    it('delegate vote "yes" in main phase, new delegate vote "no" in objection (voteForMulti)', async () => {
      const delegateList= [[delegate2, holder29], [delegate2, holder51]]
      for (const [delegate, holder] of delegateList) {
        await assignDelegate(delegate, holder)
      }

      const voteId = createdVoteId(await voting.newVote(EMPTY_CALLS_SCRIPT, 'metadata'))

      const delegatedVoters = await voting.getDelegatedVoters(delegate2, 0, 3)
      assertArraysEqualAsSets(delegatedVoters, [holder29, holder51])

      await attemptVoteForMultiple(voteId, true, delegatedVoters, delegate2)

      await voting.mockIncreaseTime(votingDuration - objectionPhase)
      await verifyVoteYN(voteId, LDO51.add(LDO29), 0)

      const { phase } = await voting.getVote(voteId)
      assert.equal(phase, OBJECTION_PHASE)

      const objectorList = [[delegate1, holder29], [delegate1, holder51]]

      for (const [delegate, holder] of objectorList) {
        await assignDelegate(delegate, holder)
      }

      await attemptVoteForMultiple(voteId, false, delegatedVoters, delegate1)

      await verifyVoteYN(voteId, 0, LDO51.add(LDO29))

      const voterState = await voting.getVoterStateMultipleAtVote(voteId, delegatedVoters)
      assertArraysEqualAsSets(voterState, [VOTER_STATE.DELEGATE_NAY.toString()])
    })

    // A delegate is voting "yea" at the last moment of a vote's main phase. Delegated voters
    // should be able to overpower the delegate during the objection phase.
    it('delegate vote in main phase, voter overpower in objection (voteFor)', async () => {
      const delegateList = [[delegate1, holder1], [delegate1, holder20]]

      for (const [delegate, holder] of delegateList) {
        await assignDelegate(delegate, holder)
      }

      const voteId = createdVoteId(await voting.newVote(EMPTY_CALLS_SCRIPT, 'metadata'))

      const delegatedVoters = await voting.getDelegatedVoters(delegate1, 0, 3)
      assertArraysEqualAsSets(delegatedVoters, [holder1, holder20])

      for (const holder of delegatedVoters) {
        await attemptVoteFor(voteId, true, holder, delegate1)
      }

      await voting.mockIncreaseTime(votingDuration - objectionPhase)
      await verifyVoteYN(voteId, LDO1.add(LDO20), 0)

      const { phase } = await voting.getVote(voteId)
      assert.equal(phase, OBJECTION_PHASE)

      for (const holder of delegatedVoters) {
        await vote(voteId, false, false, holder)
      }
      await verifyVoteYN(voteId, 0, LDO1.add(LDO20))

      const voterState = await voting.getVoterStateMultipleAtVote(voteId, delegatedVoters)
      assertArraysEqualAsSets(voterState, [VOTER_STATE.NAY.toString()])
    })

    // A delegate is voting "yea" at the last moment of a vote's main phase. Delegated voters
    // should be able to overpower the delegate during the objection phase.
    it('delegate vote in main phase, voter overpower in objection (voteForMulti)', async () => {
      const delegateList= [ [delegate2, holder29], [delegate2, holder51] ]
      for (const [delegate, holder] of delegateList) {
        await assignDelegate(delegate, holder)
      }

      const voteId = createdVoteId(await voting.newVote(EMPTY_CALLS_SCRIPT, 'metadata'))

      const delegatedVoters = await voting.getDelegatedVoters(delegate2, 0, 3)
      assertArraysEqualAsSets(delegatedVoters, [holder29,holder51])

      await attemptVoteForMultiple(voteId, true, delegatedVoters, delegate2)

      await voting.mockIncreaseTime(votingDuration - objectionPhase)
      await verifyVoteYN(voteId, LDO51.add(LDO29), 0)

      const { phase } = await voting.getVote(voteId)
      assert.equal(phase, OBJECTION_PHASE)

      for (const holder of delegatedVoters) {
        await vote(voteId, false, false, holder)
      }
      await verifyVoteYN(voteId, 0, LDO51.add(LDO29))

      const voterState = await voting.getVoterStateMultipleAtVote(voteId, delegatedVoters)
      assertArraysEqualAsSets(voterState, [VOTER_STATE.NAY.toString()])
    })

    // If a delegate was spammed by a large amount of fake delegated voters, they can still easily
    // retrieve an actual voters list and vote for that list.
    it('delegate can vote after spam', async () => {
      await assignDelegate(delegate2, holder29)
      for (const holder of spamHolders) {
        await token.generateTokens(holder, LDO3)
        await assignDelegate(delegate2, holder)
      }
      await assignDelegate(delegate2, holder51)

      const voteId = createdVoteId(await voting.newVote(EMPTY_CALLS_SCRIPT, 'metadata'))

      const delegatedVoters = await voting.getDelegatedVoters(delegate2, 0, 600)
      assertArraysEqualAsSets(delegatedVoters, [holder29, ...spamHolders, holder51])

      await attemptVoteForMultiple(voteId, true, [holder29, holder51], delegate2)

      await verifyVoteYN(voteId, LDO51.add(LDO29), 0)

      const voterState = await voting.getVoterStateMultipleAtVote(voteId, [holder29, holder51])
      assertArraysEqualAsSets(voterState, [VOTER_STATE.DELEGATE_YEA.toString()])

      const voterStateSpam = await voting.getVoterStateMultipleAtVote(voteId, spamHolders)
      assertArraysEqualAsSets(voterStateSpam, [VOTER_STATE.ABSENT.toString()])
    }).timeout(60_000);

    ///end
  })

  context('delegated voters getters', () => {
    const neededSupport = pct16(50)
    const minimumAcceptanceQuorum = pct16(20)
    const decimals = 18
    const defaultLimit = 100
    const voters = [{
      account: holder1,
      balance: bigExp(1, decimals)
    },{
      account: holder2,
      balance: bigExp(2, decimals)
    }, {
      account: holder20,
      balance: bigExp(20, decimals)
    }, {
      account: holder29,
      balance: bigExp(29, decimals)
    }]
    let voteId

    beforeEach(async () => {
      token = await MiniMeToken.new(ZERO_ADDRESS, ZERO_ADDRESS, 0, 'n', decimals, 'n', true) // empty parameters minime

      await voting.initialize(token.address, neededSupport, minimumAcceptanceQuorum, votingDuration, 0)

      for (let i = 0; i < voters.length; i++) {
        await token.generateTokens(voters[i].account, voters[i].balance)
        await voting.assignDelegate(delegate1, {from: voters[i].account})
      }

      executionTarget = await ExecutionTarget.new()

      const action = {to: executionTarget.address, calldata: executionTarget.contract.methods.execute().encodeABI()}
      script = encodeCallScript([action, action])

      const receipt = await voting.methods['newVote(bytes,string)'](script, 'metadata', {from: holder51});
      voteId = getEventArgument(receipt, 'StartVote', 'voteId')
    })

    it('should return correct delegated voters count', async () => {
      const delegatedVotersCount = (await voting.getDelegatedVotersCount(delegate1)).toNumber()
      assert(delegatedVotersCount === voters.length)
    })

    it(`revert if "_delegate" is zero address`, async () => {
      await assertRevert(
        voting.getDelegatedVotersCount(ZERO_ADDRESS),
        ERRORS.VOTING_ZERO_ADDRESS_PASSED
      )

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
      const delegatedVoters = await voting.getDelegatedVoters(nonHolder, 100, defaultLimit)
      assert(delegatedVoters.length === 0, 'votersList should be empty')
    })

    it(`if delegatedVoters array length is 0, return two empty arrays`, async () => {
      const delegatedVoters = await voting.getDelegatedVoters(nonHolder, 0, defaultLimit)
      const delegatedVotersVotingPower = await voting.getVotingPowerMultiple(delegatedVoters)
      assert(delegatedVoters.length === 0, 'votersList should be empty')
      assert(delegatedVotersVotingPower.length === 0, 'votingPowerList should be empty')
    })

    it(`should return correct delegated voters data if offset + limit >= votersCount`, async () => {
      const offset = 2
      const limit = 5
      const delegatedVoters = await voting.getDelegatedVoters(delegate1, offset, limit)
      const delegatedVotersCount = (await voting.getDelegatedVotersCount(delegate1)).toNumber()
      const delegatedVotersCountToReturn = delegatedVotersCount - offset

      assert(delegatedVoters.length === delegatedVotersCountToReturn)

      const votersSlice = voters.slice(offset, delegatedVotersCount)
      const votersListSlice = votersSlice.map(voter => voter.account)
      assertArraysEqualAsSets(delegatedVoters, votersListSlice, 'votersList should be correct')

      const votingPowerListSlice = votersSlice.map((voter) => voter.balance.toString())

      const votingPowerList = (await voting.getVotingPowerMultiple(delegatedVoters)).map(votingPower => votingPower.toString())
      assertArraysEqualAsSets(votingPowerList, votingPowerListSlice, 'votingPowerList should be correct')
    })

    it(`should return correct delegated voters data if offset + limit < votersCount`, async () => {
      const offset = 1
      const limit = 1
      const delegatedVoters = await voting.getDelegatedVoters(delegate1, offset, limit)

      assert(delegatedVoters.length === limit)

      const votersSlice = voters.slice(offset, offset + limit)
      const votersListSlice = votersSlice.map(voter => voter.account)
      assertArraysEqualAsSets(delegatedVoters, votersListSlice, 'votersList should be correct')

      const votingPowerListSlice = votersSlice.map((voter) => voter.balance.toString())
      const votingPowerList = (await voting.getVotingPowerMultiple(delegatedVoters)).map(votingPower => votingPower.toString())
      assertArraysEqualAsSets(votingPowerList, votingPowerListSlice, 'votingPowerList should be correct')
    })

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
      const delegate = await voting.getDelegate(holder1)
      assert.equal(delegate, delegate1, 'should return delegate1 address')
    })

    it(`voting power getters`, async () => {
      const initialVotingPower = voters.map(v => v.balance.toString())
      const votersAddresses = voters.map(v => v.account)

      await assertRevert(voting.getVotingPowerMultipleAtVote(voteId + 1, votersAddresses), ERRORS.VOTING_NO_VOTE)

      const currentVotingPower = await voting.getVotingPowerMultiple(votersAddresses)
      assertArraysEqualAsSets(currentVotingPower, initialVotingPower, 'current voting power values should match')

      const updatedVoterIndex = 0
      const vpAddition = bigExp(1, decimals)
      await token.generateTokens(voters[updatedVoterIndex].account, vpAddition)
      const updatedVotingPowerToCompare = voters.map((v, i) => {
        if (i === updatedVoterIndex) {
          return v.balance.add(vpAddition).toString()
        }
        return v.balance.toString()
      })
      const updatedVotingPower = await voting.getVotingPowerMultiple(votersAddresses)
      assertArraysEqualAsSets(updatedVotingPower, updatedVotingPowerToCompare, 'current voting power values should match after update')

      const votingPowerAtVote = await voting.getVotingPowerMultipleAtVote(voteId, votersAddresses)
      assertArraysEqualAsSets(votingPowerAtVote, initialVotingPower, 'voting power at vote should match vp without update')
    })
  })

  context('voting as delegate', () => {
    let script, voteId, creator, metadata

    const neededSupport = pct16(50)
    const minimumAcceptanceQuorum = pct16(20)
    const decimals = 18
    const voters = [{
      account: holder1,
      balance: bigExp(1, decimals)
    }, {
      account: holder2,
      balance: bigExp(2, decimals)
    }, {
      account: holder20,
      balance: bigExp(20, decimals)
    }, {
      account: holder29,
      balance: bigExp(29, decimals)
    }, {
      account: holder51,
      balance: bigExp(51, decimals)
    }]

    beforeEach(async () => {
      token = await MiniMeToken.new(ZERO_ADDRESS, ZERO_ADDRESS, 0, 'n', decimals, 'n', true) // empty parameters minime

      await voting.initialize(token.address, neededSupport, minimumAcceptanceQuorum, votingDuration, objectionPhase)

      for (let i = 0; i < voters.length; i++) {
        await token.generateTokens(voters[i].account, voters[i].balance)
        await voting.assignDelegate(delegate1, {from: voters[i].account})
      }
      await token.generateTokens(ZERO_ADDRESS, bigExp(1, decimals))

      executionTarget = await ExecutionTarget.new()

      const action = {to: executionTarget.address, calldata: executionTarget.contract.methods.execute().encodeABI()}
      script = encodeCallScript([action, action])

      await voting.unassignDelegate({from: holder1})
      await token.transfer(holder51, bigExp(2, decimals), { from: holder2 })

      const receipt = await voting.methods['newVote(bytes,string)'](script, 'metadata', {from: holder51});
      voteId = getEventArgument(receipt, 'StartVote', 'voteId')
      creator = getEventArgument(receipt, 'StartVote', 'creator')
      metadata = getEventArgument(receipt, 'StartVote', 'metadata')
    })

    it(`getVoterStateMultipleAtVote`, async () => {
      await voting.vote(voteId, true, false, { from: holder20 })
      await voting.vote(voteId, false, false, { from: holder29 })
      await voting.attemptVoteForMultiple(voteId, false, [holder51], {from: delegate1})

      await assertRevert(voting.getVoterStateMultipleAtVote(voteId + 1, [holder51]), ERRORS.VOTING_NO_VOTE)
      const votersState = await voting.getVoterStateMultipleAtVote(voteId, [holder20, holder29, holder51])
      assert.equal(votersState[0], VOTER_STATE.YEA, `holder20 should have 'yea' state`)
      assert.equal(votersState[1], VOTER_STATE.NAY, `holder29 should have 'nay' state`)
      assert.equal(votersState[2], VOTER_STATE.DELEGATE_NAY, `holder51 should have 'delegateNay' state`)
    })

    it(`revert if vote does not exist`, async () => {
      await assertRevert(
        voting.attemptVoteForMultiple(voteId + 1, false, [holder51], {from: delegate1}),
        ERRORS.VOTING_NO_VOTE
      )
    })

    it(`revert if vote has already ended`, async () => {
      await voting.mockIncreaseTime(votingDuration + 1)
      await assertRevert(
        voting.attemptVoteForMultiple(voteId, false, [holder51], {from: delegate1}),
        ERRORS.VOTING_CAN_NOT_VOTE
      )
    })

    it(`revert if vote has already been executed`, async () => {
      await voting.vote(voteId, true, true, { from: holder51 })
      await voting.mockIncreaseTime(votingDuration + 1)
      await voting.executeVote(voteId)

      await assertRevert(
        voting.attemptVoteForMultiple(voteId, true, [holder51], {from: delegate1}),
        ERRORS.VOTING_CAN_NOT_VOTE
      )
    })

    it(`revert if trying to vote 'yea' during objection phase`, async () => {
      await voting.mockIncreaseTime(mainPhase + 200)
      await assertRevert(
        voting.attemptVoteForMultiple(voteId, true, [holder51], {from: delegate1}),
        ERRORS.VOTING_CAN_NOT_VOTE
      )
    })

    it(`revert if one of the voters has 0 LDO`, async () => {
      // holder 2 has 0 LDO
      await assertRevert(
        voting.attemptVoteForMultiple(voteId, true, [holder51, holder2, holder1], {from: delegate1}),
        ERRORS.VOTING_NO_VOTING_POWER
      )
  })

    it(`skip zero address passed`, async () => {
      // Skip if zero address is one of the voters
      let tx = await voting.attemptVoteForMultiple(voteId, true, [holder51, ZERO_ADDRESS], {from: delegate1})

      assertAmountOfEvents(tx, 'CastVote', {expectedAmount: 1})
      assertEvent(tx, 'CastVote', {expectedArgs: {voteId, voter: holder51, supports: true}})

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
      // impossible to delegate to it. But holder51 will be skipped.
      await assertRevert(
        voting.attemptVoteForMultiple(voteId, true, [holder51], {from: signerZero.address}),
        ERRORS.VOTING_CAN_NOT_VOTE_FOR
      )
    })

    it(`one of the voters voted beforehand`, async () => {
      await voting.vote(voteId, false, false, { from: holder29 })
      const tx = await voting.attemptVoteForMultiple(voteId, true, [holder20, holder29], {from: delegate1});

      assertAmountOfEvents(tx, 'CastVote', {expectedAmount: 1})
      assertAmountOfEvents(tx, 'AttemptCastVoteAsDelegate', {expectedAmount: 1})
      assertEvent(tx, 'CastVote', {expectedArgs: {voteId, voter: holder20, supports: true}})
      assertEvent(tx, 'AttemptCastVoteAsDelegate', {expectedArgs: {voteId, delegate: delegate1}})
      const votersFromEvent = getEventArgument(tx, 'AttemptCastVoteAsDelegate', 'voters')
      assertArraysEqualAsSets([holder20, holder29], votersFromEvent)

      assert.equal(await voting.getVoterState(voteId, holder29), VOTER_STATE.NAY, `holder29 should have 'nay' state`)
      assert.equal(await voting.getVoterState(voteId, holder20), VOTER_STATE.DELEGATE_YEA, `holder20 should have 'delegateYea' state`)
    })

    it(`vote for multiple with duplicates`, async () => {
      const tx = await voting.attemptVoteForMultiple(voteId, false, [holder29, holder29], {from: delegate1});

      assertAmountOfEvents(tx, 'CastVote', {expectedAmount: 2})
      assertAmountOfEvents(tx, 'AttemptCastVoteAsDelegate', {expectedAmount: 1})
      assert.equal(await voting.getVoterState(voteId, holder29), VOTER_STATE.DELEGATE_NAY, `holder29 should have 'delegateNay' state`)
      const vote = await voting.getVote(voteId)
      assertBn(vote.nay, bigExp(29, decimals), 'nay should be 29')
    })

    it(`vote for empty list`, async () => {
      await assertRevert(
        voting.attemptVoteForMultiple(voteId, false, [], {from: delegate1}),
        ERRORS.VOTING_CAN_NOT_VOTE_FOR
      )
    })

    it(`skipped vote for multiple for all voters from list`, async () => {
      await voting.vote(voteId, false, false, { from: holder20 })
      await voting.vote(voteId, false, false, { from: holder29 })
      await assertRevert(
        voting.attemptVoteForMultiple(voteId, false, [holder20, holder29], {from: delegate1}),
        ERRORS.VOTING_CAN_NOT_VOTE_FOR
      )
    })

    it(`successful vote for multiple`, async () => {
      const delegatedVotersAddresses = await voting.getDelegatedVoters(delegate1, 0, 100)
      const delegatedVotersVotingPower = await voting.getVotingPowerMultipleAtVote(voteId, delegatedVotersAddresses)
      const filteredDelegatedVoters = []
      for (let i = 0; i < delegatedVotersAddresses.length; i++) {
        const votingPower = delegatedVotersVotingPower[i]
        if (votingPower.gt(bigExp(0, decimals))) {
          filteredDelegatedVoters.push({address: delegatedVotersAddresses[i], votingPower})
        }
      }
      const filteredDelegatedVotersAddresses = filteredDelegatedVoters.map(({address}) => address)
      const tx = await voting.attemptVoteForMultiple(
        voteId,
        false,
        filteredDelegatedVotersAddresses,
        {from: delegate1}
      );

      // Check amount of events
      assertAmountOfEvents(tx, 'CastVote', {expectedAmount: filteredDelegatedVoters.length})
      assertAmountOfEvents(tx, 'AttemptCastVoteAsDelegate', {expectedAmount: 1})

      // Check events content
      for (let i = 0; i < filteredDelegatedVoters.length; i++) {
        const {address, votingPower} = filteredDelegatedVoters[i]
        assertEvent(tx, 'CastVote', {index: i, expectedArgs: {voteId, voter: address, supports: false, stake: votingPower}})
      }
      assertEvent(tx, 'AttemptCastVoteAsDelegate', {expectedArgs: {voteId, delegate: delegate1}})
      const votersFromEvent = getEventArgument(tx, 'AttemptCastVoteAsDelegate', 'voters')
      assertArraysEqualAsSets(filteredDelegatedVoters, votersFromEvent)

      // Check voters' state
      const votersState = await voting.getVoterStateMultipleAtVote(voteId, filteredDelegatedVotersAddresses)
      votersState.every((state) => {
        assert.equal(state, VOTER_STATE.DELEGATE_NAY.toString(), `voter should have 'delegateNay' state`)
      })

      // Check applied VP
      const vote = await voting.getVote(voteId)
      const votingPowerSum = filteredDelegatedVoters.reduce(
        (sum, {votingPower}) => sum.add(votingPower),
        bigExp(0, decimals)
      )

      assertBn(vote.yea, bigExp(0, decimals), 'yea should be 0')
      assertBn(vote.nay, votingPowerSum, 'nay should be sum of all VP')
    })

    it(`successful vote for single`, async () => {
      const tx = await voting.attemptVoteFor(voteId, false, holder29, {from: delegate1})

      // Check amount of events
      assertAmountOfEvents(tx, 'CastVote', {expectedAmount: 1})
      assertAmountOfEvents(tx, 'AttemptCastVoteAsDelegate', {expectedAmount: 1})

      const holder29VP = bigExp(29, decimals)

      // Check events content
      assertEvent(tx, 'CastVote', { expectedArgs: {voteId, voter: holder29, supports: false, stake: holder29VP}})
      assertEvent(tx, 'AttemptCastVoteAsDelegate', { expectedArgs: {voteId, delegate: delegate1}})
      const votersFromEvent = getEventArgument(tx, 'AttemptCastVoteAsDelegate', 'voters')
      assertArraysEqualAsSets([holder29], votersFromEvent)

      // Check voter's state
      assert.equal(await voting.getVoterState(voteId, holder29), VOTER_STATE.DELEGATE_NAY, `holder29 should have 'delegateNay' state`)

      // Check applied VP
      const vote = await voting.getVote(voteId)
      assertBn(vote.yea, bigExp(0, decimals), 'yea should be 0')
      assertBn(vote.nay, holder29VP, 'nay should be holder29 VP')
    })

  })

  context.skip('Gas estimation tests (should be skipped)', () => {
    let script, voteId, creator, metadata

    const neededSupport = pct16(50)
    const minimumAcceptanceQuorum = pct16(20)
    const decimals = 18

    beforeEach(async () => {
      token = await MiniMeToken.new(ZERO_ADDRESS, ZERO_ADDRESS, 0, 'n', decimals, 'n', true) // empty parameters minime

      await voting.initialize(token.address, neededSupport, minimumAcceptanceQuorum, votingDuration, objectionPhase)
      await token.generateTokens(holder51, bigExp(51, decimals))

      for (const holder of spamHolders) {
        await token.generateTokens(holder, bigExp(1, decimals))
        await voting.assignDelegate(delegate1, {from: holder})
      }

      executionTarget = await ExecutionTarget.new()

      const action = {to: executionTarget.address, calldata: executionTarget.contract.methods.execute().encodeABI()}
      script = encodeCallScript([action, action])

      const receipt = await voting.methods['newVote(bytes,string)'](script, 'metadata', {from: holder51})
      voteId = getEventArgument(receipt, 'StartVote', 'voteId')
      creator = getEventArgument(receipt, 'StartVote', 'creator')
      metadata = getEventArgument(receipt, 'StartVote', 'metadata')
    })

    it(`voting without delegation`, async () => {
      const voter = spamHolders[0]
      const tx = await voting.vote(voteId, true, false, {from: voter})
      console.log('Gas used for a voting without delegation:', tx.receipt.gasUsed)
    })

    it(`voting for 1`, async () => {
      const voter = spamHolders[0]
      const tx = await voting.attemptVoteFor(voteId, false, voter, {from: delegate1})
      console.log('Gas used for voting for 1:', tx.receipt.gasUsed)
    })

    it(`voting for 10`, async () => {
      const voters = spamHolders.slice(0, 10)
      const tx = await voting.attemptVoteForMultiple(voteId, false, voters, {from: delegate1})
      console.log('Gas used for voting for 10:', tx.receipt.gasUsed)
    })

    it(`voting for 100`, async () => {
      const voters = spamHolders.slice(0, 100)
      const tx = await voting.attemptVoteForMultiple(voteId, false, voters, {from: delegate1})
      console.log('Gas used for voting for 100:', tx.receipt.gasUsed)
    })

  })
})
