const ERRORS = require('./helpers/errors')
const assertArraysEqualAsSets = require('./helpers/assertArrayAsSets')
const { assertBn, assertRevert, assertAmountOfEvents, assertEvent } = require('@aragon/contract-helpers-test/src/asserts')
const { pct16, bn, bigExp, getEventArgument, ZERO_ADDRESS } = require('@aragon/contract-helpers-test')
const { newDao, installNewApp, encodeCallScript, ANY_ENTITY, EMPTY_CALLS_SCRIPT } = require('@aragon/contract-helpers-test/src/aragon-os')
const { assert } = require('chai')

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

  context('voting delegate', () => {
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

    const setDelegate = async (delegate, holder ) => {
      const tx = await voting.setDelegate(delegate, {from: holder})
      assertEvent(tx, 'SetDelegate', {
        expectedArgs: {voter: holder, delegate}
      })
      assertAmountOfEvents(tx, 'SetDelegate', {expectedAmount: 1})
    }
    const attemptVoteFor = async (voteId, supports, holder, delegate) => {
      const tx = await voting.attemptVoteFor(voteId, supports, holder, {from: delegate})
      assertEvent(tx, 'CastVote', {
        expectedArgs: {voteId: voteId, voter: holder, supports: supports, stake: initBalance[holder]}
      })
      assertEvent(tx, 'CastVoteAsDelegate', {
        expectedArgs: {voteId: voteId, delegate: delegate, voter: holder, supports: supports, stake: initBalance[holder]}
      })
      assertAmountOfEvents(tx, 'CastVote', {expectedAmount: 1})
      assertAmountOfEvents(tx, 'CastVoteAsDelegate', {expectedAmount: 1})
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
        assertEvent(tx, 'CastVoteAsDelegate', {
          index,
          expectedArgs: {voteId, delegate, voter: holder, supports, stake}
        })
      }
      assertAmountOfEvents(tx, 'CastVote', {expectedAmount: holders.length})
      assertAmountOfEvents(tx, 'CastVoteAsDelegate', {expectedAmount: holders.length})
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
        voting.setDelegate(ZERO_ADDRESS, {from: holder29}),
        ERRORS.VOTING_ZERO_ADDRESS_PASSED
      )
    })

    it(`voter can't assign themself as a delegate`, async () => {
      await assertRevert(
        voting.setDelegate(holder29, {from: holder29}),
        ERRORS.VOTING_SELF_DELEGATE
      )
    })

    it(`voter can't assign their current delegate as a delegate`, async () => {
      await voting.setDelegate(delegate1, {from: holder29})
      await assertRevert(
        voting.setDelegate(delegate1, {from: holder29}),
        ERRORS.VOTING_DELEGATE_SAME_AS_PREV
      )
    })

    it(`voter can't unassign their delegate if they wasn't assigned before`, async () => {
      await assertRevert(
        voting.resetDelegate({from: holder29}),
        ERRORS.VOTING_DELEGATE_NOT_SET
      )
    })

    it('voter can set delegate', async () => {
      let delegatedVoters = (await voting.getDelegatedVoters(delegate1, 0, 1))[0]
      assert.equal(delegatedVoters.length, 0, 'delegate1 should not be a delegate of anyone')

      const tx = await voting.setDelegate(delegate1, {from: holder29})
      assertEvent(tx, 'SetDelegate', {
        expectedArgs: {voter: holder29, delegate: delegate1}
      })
      assertAmountOfEvents(tx, 'SetDelegate', {expectedAmount: 1})

      const delegate = await voting.getDelegate(holder29)
      assert.equal(delegate, delegate1, 'holder29 should have delegate1 as a delegate')

      delegatedVoters = (await voting.getDelegatedVoters(delegate1, 0, 1))[0]
      assertArraysEqualAsSets(delegatedVoters, [holder29], 'delegate1 should be a delegate of holder29')
    })

    it('voter can remove delegate', async () => {
      let delegatedVoters = (await voting.getDelegatedVoters(delegate1, 0, 1))[0]
      assert.equal(delegatedVoters.length, 0, 'delegate1 should not be a delegate of anyone')

      await voting.setDelegate(delegate1, {from: holder29})

      delegatedVoters = (await voting.getDelegatedVoters(delegate1, 0, 1))[0]
      assertArraysEqualAsSets(delegatedVoters, [holder29], 'delegate1 should be a delegate of holder29')

      const tx = await voting.resetDelegate({from: holder29})
      assertEvent(tx, 'ResetDelegate', {
        expectedArgs: {voter: holder29, delegate: delegate1}
      })
      assertAmountOfEvents(tx, 'ResetDelegate', {expectedAmount: 1})
      delegatedVoters = (await voting.getDelegatedVoters(delegate1, 0, 1))[0]
      assertArraysEqualAsSets(delegatedVoters, [], 'delegate1 should not be a delegate of anyone')
    })

    it('voters can remove delegate', async () => {
      let delegatedVoters = (await voting.getDelegatedVoters(delegate1, 0, 1))[0]
      assert.equal(delegatedVoters.length, 0, 'delegate1 should not be a delegate of anyone')

      await voting.setDelegate(delegate1, {from: holder20})
      await voting.setDelegate(delegate1, {from: holder29})
      await voting.setDelegate(delegate1, {from: holder51})

      const tx1 = await voting.resetDelegate({from: holder29})
      assertEvent(tx1, 'ResetDelegate', {
        expectedArgs: {voter: holder29, delegate: delegate1}
      })
      assertAmountOfEvents(tx1, 'ResetDelegate', {expectedAmount: 1})
      delegatedVoters = (await voting.getDelegatedVoters(delegate1, 0, 5))[0]
      assertArraysEqualAsSets(delegatedVoters, [holder20, holder51], 'delegate1 have holder20 and holder51 as a delegated voters')

      const tx2 = await voting.resetDelegate({from: holder51})
      assertEvent(tx2, 'ResetDelegate', {
        expectedArgs: {voter: holder51, delegate: delegate1}
      })
      assertAmountOfEvents(tx2, 'ResetDelegate', {expectedAmount: 1})
      delegatedVoters = (await voting.getDelegatedVoters(delegate1, 0, 1))[0]
      assertArraysEqualAsSets(delegatedVoters, [holder20], 'delegate1 have only holder20 as a delegated voter')
    })

    it('voter can change delegate', async () => {
      let delegatedVoters = (await voting.getDelegatedVoters(delegate1, 0, 1))[0]
      assert.equal(delegatedVoters.length, 0, 'delegate1 should not be a delegate of anyone')
      delegatedVoters = (await voting.getDelegatedVoters(delegate2, 0, 1))[0]
      assert.equal(delegatedVoters.length, 0, 'delegate2 should not be a delegate of anyone')

      await voting.setDelegate(delegate1, {from: holder29})
      await voting.setDelegate(delegate2, {from: holder51})

      await voting.setDelegate(delegate2, {from: holder29})

      const delegatedVotersDelegate1 = (await voting.getDelegatedVoters(delegate1, 0, 1))[0]
      assertArraysEqualAsSets(delegatedVotersDelegate1, [], 'delegate1 should not be a delegate of anyone')
      const delegatedVotersDelegate2 = (await voting.getDelegatedVoters(delegate2, 0, 2))[0]
      assertArraysEqualAsSets(delegatedVotersDelegate2, [holder29, holder51], 'delegate2 should be a delegate of holder29 and holder51')
    })

    it('delegate can manage several voters', async () => {
      let delegatedVoters = (await voting.getDelegatedVoters(delegate1, 0, 1))[0]
      assert.equal(delegatedVoters.length, 0, 'delegate1 should not be a delegate of anyone')

      const tx1 = await voting.setDelegate(delegate1, {from: holder29})
      assertEvent(tx1, 'SetDelegate', {
        expectedArgs: {voter: holder29, delegate: delegate1}
      })
      assertAmountOfEvents(tx1, 'SetDelegate', {expectedAmount: 1})

      const tx2 = await voting.setDelegate(delegate1, {from: holder51})
      assertEvent(tx2, 'SetDelegate', {
        expectedArgs: {voter: holder51, delegate: delegate1}
      })
      assertAmountOfEvents(tx2, 'SetDelegate', {expectedAmount: 1})

      delegatedVoters = (await voting.getDelegatedVoters(delegate1, 0, 2))[0]
      assertArraysEqualAsSets(delegatedVoters, [holder29, holder51], 'delegate1 should be a delegate of holder29 and holder51')
    })

    // Multiple voters with non-zero balances of governance token are delegating their voting
    // power to a single delegate. The voting starts and the delegate is voting for all of them - first
    // they get the full list of voters with their balance snapshot and vote states of the given voting,
    // then they vote for that list.
    it('delegate can manage several voters and vote for all (voteFor)', async () => {
      const delegateList= [ [delegate1, holder1], [delegate1, holder20] ]

      for (const [delegate, holder] of delegateList) {
        await setDelegate(delegate, holder)
      }

      const voteId = createdVoteId(await voting.newVote(EMPTY_CALLS_SCRIPT, 'metadata'))

      const delegatedVotersData = await voting.getDelegatedVotersAtVote(delegate1, 0, 3, voteId)
      assertArraysEqualAsSets(delegatedVotersData[0], [holder1,holder20])

      for (const holder of delegatedVotersData[0]) {
        await attemptVoteFor(voteId, false, holder, delegate1)
      }

      await verifyVoteYN(voteId, 0, LDO1.add(LDO20))
      const voterState = await voting.getVotersStateAtVote(voteId, delegatedVotersData[0])
      assertArraysEqualAsSets(voterState, [VOTER_STATE.DELEGATE_NAY.toString()])
    })

    // Multiple voters with non-zero balances of governance token are delegating their voting
    // power to a single delegate. The voting starts and the delegate is voting for all of them - first
    // they get the full list of voters with their balance snapshot and vote states of the given voting,
    // then they vote for that list.
    it('delegate can manage several voters and vote all (voteForMulti)', async () => {
      const delegateList= [ [delegate2, holder29], [delegate2, holder51] ]
      for (const [delegate, holder] of delegateList) {
        await setDelegate(delegate, holder)
      }

      const voteId = createdVoteId(await voting.newVote(EMPTY_CALLS_SCRIPT, 'metadata'))

      const delegatedVotersData = await voting.getDelegatedVotersAtVote(delegate2, 0, 3, voteId)

      assertArraysEqualAsSets(delegatedVotersData[0], [holder29,holder51])

      await attemptVoteForMultiple(voteId, true, delegatedVotersData[0], delegate2)
      await verifyVoteYN(voteId, LDO51.add(LDO29), 0)

      const voterState = await voting.getVotersStateAtVote(voteId, delegatedVotersData[0])
      assertArraysEqualAsSets(voterState, [VOTER_STATE.DELEGATE_YEA.toString()])
    })

    // Multiple voters with non-zero balances of governance token are delegating their voting
    // power to a single delegate. The voting starts and the delegate is voting for one of them.
    it('delegate can manage several voters and vote for first (voteFor)', async () => {
      const delegateList= [ [delegate1, holder1], [delegate1, holder20] ]

      for (const [delegate, holder] of delegateList) {
        await setDelegate(delegate, holder)
      }

      const voteId = createdVoteId(await voting.newVote(EMPTY_CALLS_SCRIPT, 'metadata'))

      const delegatedVotersData = await voting.getDelegatedVotersAtVote(delegate1, 0, 3, voteId)
      assertArraysEqualAsSets(delegatedVotersData[0], [holder1, holder20])

      await attemptVoteFor(voteId, false, holder1, delegate1)

      await verifyVoteYN(voteId, 0, LDO1)

      const voterStateHolder1 = await voting.getVotersStateAtVote(voteId, [holder1])
      const voterStateHolder20 = await voting.getVotersStateAtVote(voteId, [holder20])

      assertArraysEqualAsSets(voterStateHolder1, [VOTER_STATE.DELEGATE_NAY.toString()])
      assertArraysEqualAsSets(voterStateHolder20, [VOTER_STATE.ABSENT.toString()])
    })

    // Multiple voters with non-zero balances of governance token are delegating their voting
    // power to a single delegate. The voting starts and the delegate is voting for one of them.
    it('delegate can manage several voters and vote for first (voteForMulti)', async () => {
      const delegateList= [ [delegate2, holder29], [delegate2, holder51] ]
      for (const [delegate, holder] of delegateList) {
        setDelegate(delegate, holder)
      }

      const voteId = createdVoteId(await voting.newVote(EMPTY_CALLS_SCRIPT, 'metadata'))

      const delegatedVotersData = await voting.getDelegatedVotersAtVote(delegate2, 0, 3, voteId)

      assertArraysEqualAsSets(delegatedVotersData[0], [ holder29, holder51 ])

      await attemptVoteForMultiple(voteId, true, [holder29], delegate2)

      await verifyVoteYN(voteId, LDO29, 0)

      const voterStateHolder29 = await voting.getVotersStateAtVote(voteId, [holder29])
      const voterStateHolder51 = await voting.getVotersStateAtVote(voteId, [holder51])

      assertArraysEqualAsSets(voterStateHolder29, [VOTER_STATE.DELEGATE_YEA.toString()])
      assertArraysEqualAsSets(voterStateHolder51, [VOTER_STATE.ABSENT.toString()])
    })

    // A delegated voter can overwrite a delegate's vote.
    it('delegated voter can overwrite a delegates vote (voteFor)', async () => {
      const [ delegate, holder] = [ delegate1, holder1 ]

      setDelegate(delegate, holder)

      const voteId = createdVoteId(await voting.newVote(EMPTY_CALLS_SCRIPT, 'metadata'))

      const delegatedVotersData = await voting.getDelegatedVotersAtVote(delegate1, 0, 3, voteId)
      assertArraysEqualAsSets(delegatedVotersData[0], [ holder1 ])

      const supports = false
      await attemptVoteFor(voteId, supports, holder, delegate1)

      const delegatedVoterState = await voting.getVotersStateAtVote(voteId, [holder])
      assertArraysEqualAsSets(delegatedVoterState, [VOTER_STATE.DELEGATE_NAY.toString()])

      await vote( voteId, !supports, false, holder)

      await verifyVoteYN(voteId, LDO1, 0)

      const voterState = await voting.getVotersStateAtVote(voteId, [holder])
      assertArraysEqualAsSets(voterState, [VOTER_STATE.YEA.toString()])
    })

    // A delegated voter can overwrite a delegate's vote.
    it('delegated voter can overwrite a delegates vote (voteForMulti)', async () => {
      const [ delegate, holder] = [ delegate2, holder29 ]

      await setDelegate(delegate, holder)

      const voteId = createdVoteId(await voting.newVote(EMPTY_CALLS_SCRIPT, 'metadata'))

      const delegatedVotersData = await voting.getDelegatedVotersAtVote(delegate2, 0, 3, voteId)
      assertArraysEqualAsSets(delegatedVotersData[0], [holder29])

      const supports = true
      await attemptVoteForMultiple(voteId, supports, [holder], delegate2)
      const delegatedVoterState = await voting.getVotersStateAtVote(voteId, [holder])
      assertArraysEqualAsSets(delegatedVoterState, [VOTER_STATE.DELEGATE_YEA.toString()])

      await vote(voteId, !supports, false, holder)

      await verifyVoteYN(voteId, 0 , LDO29)

      const voterState = await voting.getVotersStateAtVote(voteId, [holder])
      assertArraysEqualAsSets(voterState, [VOTER_STATE.NAY.toString()])
    })

    // A delegate can vote for a voter that delegated them their voting power during the active
    // phase of the vote.
    it('delegate can vote for a voter that delegated them their voting power during the active phase (voteFor)', async () => {
      const [ delegate, holder] = [ delegate2, holder1 ]

      await setDelegate(delegate, holder)

      const voteId = createdVoteId(await voting.newVote(EMPTY_CALLS_SCRIPT, 'metadata'))
      const { phase } = await voting.getVote(voteId)
      assert.equal(phase, MAIN_PHASE)

      await setDelegate(delegate1, holder)
      const delegatedVotersData = await voting.getDelegatedVotersAtVote(delegate1, 0, 3, voteId)
      assertArraysEqualAsSets(delegatedVotersData[0], [ holder1 ])

      await attemptVoteFor(voteId, false, holder, delegate1)

      await verifyVoteYN(voteId, 0, LDO1)

      const voterState = await voting.getVotersStateAtVote(voteId, [holder])
      assertArraysEqualAsSets(voterState, [VOTER_STATE.DELEGATE_NAY.toString()])
    })

    // A delegate can vote for a voter that delegated them their voting power during the active
    // phase of the vote.
    it('delegate can vote for a voter that delegated them their voting power during the active phase (voteForMulti)', async () => {
      const [ delegate, holder] = [ delegate1, holder29 ]

      await setDelegate(delegate, holder)

      const voteId = createdVoteId(await voting.newVote(EMPTY_CALLS_SCRIPT, 'metadata'))
      const { phase } = await voting.getVote(voteId)
      assert.equal(phase, MAIN_PHASE)

      await setDelegate(delegate2, holder)
      const delegatedVotersData = await voting.getDelegatedVotersAtVote(delegate2, 0, 3, voteId)
      assertArraysEqualAsSets(delegatedVotersData[0], [holder29])

      await attemptVoteForMultiple(voteId, true, [holder], delegate2)

      await verifyVoteYN(voteId, LDO29, 0)

      const voterState = await voting.getVotersStateAtVote(voteId, [holder])
      assertArraysEqualAsSets(voterState, [VOTER_STATE.DELEGATE_YEA.toString()])
    })

    // A delegate can't vote for a voter that acquired voting power during the active phase of the vote.
    it('delegate cant vote for a voter that acquired voting power during the active phase of the vote (voteFor)', async () => {
      const [ delegate, holder] = [ delegate1, holder1 ]

      await setDelegate(delegate, holder)

      const voteId = createdVoteId(await voting.newVote(EMPTY_CALLS_SCRIPT, 'metadata'))
      const { phase } = await voting.getVote(voteId)
      assert.equal(phase, MAIN_PHASE)

      await setDelegate(delegate2,  holder)
      const delegatedVotersData = await voting.getDelegatedVotersAtVote(delegate1, 0, 3, voteId)
      assertArraysEqualAsSets(delegatedVotersData[0], [ ])

      await assertRevert(voting.attemptVoteFor(voteId, false, holder, {from: delegate1}), ERRORS.VOTING_CAN_NOT_VOTE_FOR)
    })

    // A delegate can't vote for a voter that acquired voting power during the active phase of the vote.
    it('delegate cant vote for a voter that acquired voting power during the active phase of the vote (voteForMulti)', async () => {
      const [ delegate, holder] = [ delegate2, holder29 ]

      await setDelegate(delegate, holder)

      const voteId = createdVoteId(await voting.newVote(EMPTY_CALLS_SCRIPT, 'metadata'))
      const { phase } = await voting.getVote(voteId)
      assert.equal(phase, MAIN_PHASE)

      await setDelegate(delegate1, holder)
      const delegatedVotersData = await voting.getDelegatedVotersAtVote(delegate2, 0, 3, voteId)
      assertArraysEqualAsSets(delegatedVotersData[0], [])

      await assertRevert(voting.attemptVoteForMultiple(voteId, true, [holder], {from: delegate2}), ERRORS.VOTING_CAN_NOT_VOTE_FOR)

    })

    // If a delegated voter lost or gain some voting power after the start of the vote, a delegate
    // would still apply the full voting power of the delegated voter (at the vote's snapshot)
    it('delegate vote by snapshot vp not current (voteFor)', async () => {
      const delegateList= [ [delegate1, holder1], [delegate1, holder20] ]

      for (const [delegate, holder] of delegateList) {
        await setDelegate(delegate, holder)
      }

      const voteId = createdVoteId(await voting.newVote(EMPTY_CALLS_SCRIPT, 'metadata'))

      await token.generateTokens(holder1, bigExp(2, decimals))
      await token.destroyTokens(holder20, bigExp(5, decimals))

      const delegatedVotersData = await voting.getDelegatedVotersAtVote(delegate1, 0, 3, voteId)
      assertArraysEqualAsSets(delegatedVotersData[0], [holder1,holder20])

      for (const holder of delegatedVotersData[0]) {
        await attemptVoteFor(voteId, false, holder, delegate1)
      }
      await verifyVoteYN(voteId, 0, LDO1.add(LDO20))

      const voterState = await voting.getVotersStateAtVote(voteId, delegatedVotersData[0])
      assertArraysEqualAsSets(voterState, [VOTER_STATE.DELEGATE_NAY.toString()])
    })

    // If a delegated voter lost or gain some voting power after the start of the vote, a delegate
    // would still apply the full voting power of the delegated voter (at the vote's snapshot)
    it('delegate vote by snapshot vp not current (voteForMulti)', async () => {
      const delegateList= [ [delegate2, holder29], [delegate2, holder51] ]
      for (const [delegate, holder] of delegateList) {
        await setDelegate(delegate, holder)
      }

      const voteId = createdVoteId(await voting.newVote(EMPTY_CALLS_SCRIPT, 'metadata'))

      await token.generateTokens(holder29, bigExp(2, decimals))
      await token.destroyTokens(holder51, bigExp(5, decimals))

      const delegatedVotersData = await voting.getDelegatedVotersAtVote(delegate2, 0, 3, voteId)
      assertArraysEqualAsSets(delegatedVotersData[0], [holder29,holder51])

      await attemptVoteForMultiple(voteId, true, delegatedVotersData[0], delegate2)
      await verifyVoteYN(voteId, LDO51.add(LDO29), 0)

      const voterState = await voting.getVotersStateAtVote(voteId, delegatedVotersData[0])
      assertArraysEqualAsSets(voterState, [VOTER_STATE.DELEGATE_YEA.toString()])
    })

    // A delegate can vote for all their delegated voters even if delegate voted for them before
    // for different option (change mind)
    it('delegate change mind (voteFor)', async () => {
      const delegateList = [[delegate1, holder1], [delegate1, holder20]]

      for (const [delegate, holder] of delegateList) {
        await setDelegate(delegate, holder)
      }

      const voteId = createdVoteId(await voting.newVote(EMPTY_CALLS_SCRIPT, 'metadata'))

      const delegatedVotersData = await voting.getDelegatedVotersAtVote(delegate1, 0, 3, voteId)

      assertArraysEqualAsSets(delegatedVotersData[0], [holder1, holder20])

      for (const holder of delegatedVotersData[0]) {
        await attemptVoteFor(voteId, false, holder, delegate1)
      }
      await verifyVoteYN(voteId,0, LDO1.add(LDO20))

      for (const holder of delegatedVotersData[0]) {
        await attemptVoteFor(voteId, true, holder, delegate1)
      }
      await verifyVoteYN(voteId, LDO1.add(LDO20), 0)

      const voterState = await voting.getVotersStateAtVote(voteId, delegatedVotersData[0])
      assertArraysEqualAsSets(voterState, [VOTER_STATE.DELEGATE_YEA.toString()])
    })

    // A delegate can vote for all their delegated voters even if delegate voted for them before
    // for different option (change mind)
    it('delegate change mind (voteForMulti)', async () => {
      const delegateList= [ [delegate2, holder29], [delegate2, holder51] ]
      for (const [delegate, holder] of delegateList) {
        await setDelegate(delegate, holder)
      }

      const voteId = createdVoteId(await voting.newVote(EMPTY_CALLS_SCRIPT, 'metadata'))

      const delegatedVotersData = await voting.getDelegatedVotersAtVote(delegate2, 0, 3, voteId)
      assertArraysEqualAsSets(delegatedVotersData[0], [holder29,holder51])


      await attemptVoteForMultiple(voteId, true, delegatedVotersData[0], delegate2)
      await verifyVoteYN(voteId, LDO51.add(LDO29), 0)

      await attemptVoteForMultiple(voteId, false, delegatedVotersData[0], delegate2)
      await verifyVoteYN(voteId, 0, LDO51.add(LDO29))

      const voterState = await voting.getVotersStateAtVote(voteId, delegatedVotersData[0])
      assertArraysEqualAsSets(voterState, [VOTER_STATE.DELEGATE_NAY.toString()])
    })

    // A delegate can vote for all their delegated voters even if delegate voted for them before
    // for "no" option during the objection phase.(change mind)
    it('delegate vote "yes" in main phase, delegate vote "no" in objection (voteFor)', async () => {
      const delegateList = [[delegate1, holder1], [delegate1, holder20]]

      for (const [delegate, holder] of delegateList) {
        await setDelegate(delegate, holder)
      }

      const voteId = createdVoteId(await voting.newVote(EMPTY_CALLS_SCRIPT, 'metadata'))

      const delegatedVotersData = await voting.getDelegatedVotersAtVote(delegate1, 0, 3, voteId)
      assertArraysEqualAsSets(delegatedVotersData[0], [holder1, holder20])

      for (const holder of delegatedVotersData[0]) {
        await attemptVoteFor(voteId, true, holder, delegate1)
      }

      await voting.mockIncreaseTime(votingDuration - objectionPhase)
      await verifyVoteYN(voteId, LDO1.add(LDO20), 0)

      const { phase } = await voting.getVote(voteId)
      assert.equal(phase, OBJECTION_PHASE)

      for (const holder of delegatedVotersData[0]) {
        await attemptVoteFor(voteId, false, holder, delegate1)
      }
      await verifyVoteYN(voteId, 0, LDO1.add(LDO20))

      const voterState = await voting.getVotersStateAtVote(voteId, delegatedVotersData[0])
      assertArraysEqualAsSets(voterState, [VOTER_STATE.DELEGATE_NAY.toString()])
    })

    // A delegate can vote for all their delegated voters even if delegate voted for them before
    // for "no" option during the objection phase.(change mind)
    it('delegate vote "yes" in main phase, delegate vote "no" in objection (voteForMulti)', async () => {
      const delegateList= [ [delegate2, holder29], [delegate2, holder51] ]
      for (const [delegate, holder] of delegateList) {
        await setDelegate(delegate, holder)
      }

      const voteId = createdVoteId(await voting.newVote(EMPTY_CALLS_SCRIPT, 'metadata'))

      const delegatedVotersData = await voting.getDelegatedVotersAtVote(delegate2, 0, 3, voteId)
      assertArraysEqualAsSets(delegatedVotersData[0], [holder29,holder51])

      await attemptVoteForMultiple(voteId, true, delegatedVotersData[0], delegate2)

      await voting.mockIncreaseTime(votingDuration - objectionPhase)
      await verifyVoteYN(voteId, LDO51.add(LDO29), 0)

      const { phase } = await voting.getVote(voteId)
      assert.equal(phase, OBJECTION_PHASE)

      await attemptVoteForMultiple(voteId, false, delegatedVotersData[0], delegate2)

      await verifyVoteYN(voteId, 0, LDO51.add(LDO29))

      const voterState = await voting.getVotersStateAtVote(voteId, delegatedVotersData[0])
      assertArraysEqualAsSets(voterState, [VOTER_STATE.DELEGATE_NAY.toString()])
    })

    // A new delegate can vote "no" in objection phase for all their delegated voters
    // even if old delegate voted for "yes" them before
    it('delegate vote "yes" in main phase, new delegate vote "no" in objection (voteFor)', async () => {
      const delegateList = [[delegate1, holder1], [delegate1, holder20]]

      for (const [delegate, holder] of delegateList) {
        await setDelegate(delegate, holder)
      }

      const voteId = createdVoteId(await voting.newVote(EMPTY_CALLS_SCRIPT, 'metadata'))

      const delegatedVotersData = await voting.getDelegatedVotersAtVote(delegate1, 0, 3, voteId)
      assertArraysEqualAsSets(delegatedVotersData[0], [holder1, holder20])

      for (const holder of delegatedVotersData[0]) {
        await attemptVoteFor(voteId, true, holder, delegate1)
      }

      await voting.mockIncreaseTime(votingDuration - objectionPhase)
      await verifyVoteYN(voteId, LDO1.add(LDO20), 0)

      const { phase } = await voting.getVote(voteId)
      assert.equal(phase, OBJECTION_PHASE)

      const objectorList = [[delegate2, holder1], [delegate2, holder20]]

      for (const [delegate, holder] of objectorList) {
        await setDelegate(delegate, holder)
      }

      for (const [ delegate , holder] of objectorList) {
        await attemptVoteFor(voteId, false, holder, delegate)
      }
      await verifyVoteYN(voteId, 0, LDO1.add(LDO20))

      const voterState = await voting.getVotersStateAtVote(voteId, delegatedVotersData[0])
      assertArraysEqualAsSets(voterState, [VOTER_STATE.DELEGATE_NAY.toString()])
    })

    // A new delegate can vote "no" in objection phase for all their delegated voters
    // even if old delegate voted for "yes" them before
    it('delegate vote "yes" in main phase, new delegate vote "no" in objection (voteForMulti)', async () => {
      const delegateList= [[delegate2, holder29], [delegate2, holder51]]
      for (const [delegate, holder] of delegateList) {
        await setDelegate(delegate, holder)
      }

      const voteId = createdVoteId(await voting.newVote(EMPTY_CALLS_SCRIPT, 'metadata'))

      const delegatedVotersData = await voting.getDelegatedVotersAtVote(delegate2, 0, 3, voteId)
      assertArraysEqualAsSets(delegatedVotersData[0], [holder29, holder51])

      await attemptVoteForMultiple(voteId, true, delegatedVotersData[0], delegate2)

      await voting.mockIncreaseTime(votingDuration - objectionPhase)
      await verifyVoteYN(voteId, LDO51.add(LDO29), 0)

      const { phase } = await voting.getVote(voteId)
      assert.equal(phase, OBJECTION_PHASE)

      const objectorList = [[delegate1, holder29], [delegate1, holder51]]

      for (const [delegate, holder] of objectorList) {
        await setDelegate(delegate, holder)
      }

      await attemptVoteForMultiple(voteId, false, delegatedVotersData[0], delegate1)

      await verifyVoteYN(voteId, 0, LDO51.add(LDO29))

      const voterState = await voting.getVotersStateAtVote(voteId, delegatedVotersData[0])
      assertArraysEqualAsSets(voterState, [VOTER_STATE.DELEGATE_NAY.toString()])
    })

    // A delegate is voting "yea" at the last moment of a vote's main phase. Delegated voters
    // should be able to overpower the delegate during the objection phase.
    it('delegate vote in main phase, voter overpower in objection (voteFor)', async () => {
      const delegateList = [[delegate1, holder1], [delegate1, holder20]]

      for (const [delegate, holder] of delegateList) {
        await setDelegate(delegate, holder)
      }

      const voteId = createdVoteId(await voting.newVote(EMPTY_CALLS_SCRIPT, 'metadata'))

      const delegatedVotersData = await voting.getDelegatedVotersAtVote(delegate1, 0, 3, voteId)
      assertArraysEqualAsSets(delegatedVotersData[0], [holder1, holder20])

      for (const holder of delegatedVotersData[0]) {
        await attemptVoteFor(voteId, true, holder, delegate1)
      }

      await voting.mockIncreaseTime(votingDuration - objectionPhase)
      await verifyVoteYN(voteId, LDO1.add(LDO20), 0)

      const { phase } = await voting.getVote(voteId)
      assert.equal(phase, OBJECTION_PHASE)

      for (const holder of delegatedVotersData[0]) {
        await vote(voteId, false, false, holder)
      }
      await verifyVoteYN(voteId, 0, LDO1.add(LDO20))

      const voterState = await voting.getVotersStateAtVote(voteId, delegatedVotersData[0])
      assertArraysEqualAsSets(voterState, [VOTER_STATE.NAY.toString()])
    })

    // A delegate is voting "yea" at the last moment of a vote's main phase. Delegated voters
    // should be able to overpower the delegate during the objection phase.
    it('delegate vote in main phase, voter overpower in objection (voteForMulti)', async () => {
      const delegateList= [ [delegate2, holder29], [delegate2, holder51] ]
      for (const [delegate, holder] of delegateList) {
        await setDelegate(delegate, holder)
      }

      const voteId = createdVoteId(await voting.newVote(EMPTY_CALLS_SCRIPT, 'metadata'))

      const delegatedVotersData = await voting.getDelegatedVotersAtVote(delegate2, 0, 3, voteId)
      assertArraysEqualAsSets(delegatedVotersData[0], [holder29,holder51])

      await attemptVoteForMultiple(voteId, true, delegatedVotersData[0], delegate2)

      await voting.mockIncreaseTime(votingDuration - objectionPhase)
      await verifyVoteYN(voteId, LDO51.add(LDO29), 0)

      const { phase } = await voting.getVote(voteId)
      assert.equal(phase, OBJECTION_PHASE)

      for (const holder of delegatedVotersData[0]) {
        await vote(voteId, false, false, holder)
      }
      await verifyVoteYN(voteId, 0, LDO51.add(LDO29))

      const voterState = await voting.getVotersStateAtVote(voteId, delegatedVotersData[0])
      assertArraysEqualAsSets(voterState, [VOTER_STATE.NAY.toString()])
    })

    // If a delegate was spammed by a large amount of fake delegated voters, they can still easily
    // retrieve an actual voters list and vote for that list.
    it('delegate can vote after spam', async () => {
      await setDelegate(delegate2, holder29)
      for (const holder of spamHolders) {
        await token.generateTokens(holder, LDO3)
        await setDelegate(delegate2, holder)
      }
      await setDelegate(delegate2, holder51)

      const voteId = createdVoteId(await voting.newVote(EMPTY_CALLS_SCRIPT, 'metadata'))

      const delegatedVotersData = await voting.getDelegatedVotersAtVote(delegate2, 0, 600, voteId)
      assertArraysEqualAsSets(delegatedVotersData[0], [holder29, ...spamHolders, holder51])

      await attemptVoteForMultiple(voteId, true, [holder29, holder51], delegate2)

      await verifyVoteYN(voteId, LDO51.add(LDO29), 0)

      const voterState = await voting.getVotersStateAtVote(voteId, [holder29, holder51])
      assertArraysEqualAsSets(voterState, [VOTER_STATE.DELEGATE_YEA.toString()])

      const voterStateSpam = await voting.getVotersStateAtVote(voteId, spamHolders)
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

    beforeEach(async () => {
      token = await MiniMeToken.new(ZERO_ADDRESS, ZERO_ADDRESS, 0, 'n', decimals, 'n', true) // empty parameters minime

      await voting.initialize(token.address, neededSupport, minimumAcceptanceQuorum, votingDuration, 0)

      for (let i = 0; i < voters.length; i++) {
        await token.generateTokens(voters[i].account, voters[i].balance)
        await voting.setDelegate(delegate1, {from: voters[i].account})
      }

      executionTarget = await ExecutionTarget.new()
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

    it(`revert if "_limit" is 0`, async () => {
      await assertRevert(
        voting.getDelegatedVoters(ZERO_ADDRESS, 0, defaultLimit),
        ERRORS.VOTING_ZERO_ADDRESS_PASSED
      )
    })

    it(`if delegatedVoters array length is 0, return two empty arrays`, async () => {
      const delegatdVotersData = await voting.getDelegatedVoters(nonHolder, 0, defaultLimit)
      assert(delegatdVotersData[0].length === 0, 'votersList should be empty')
      assert(delegatdVotersData[1].length === 0, 'votingPowerList should be empty')
    })

    it(`should return correct delegated voters data if offset + limit >= votersCount`, async () => {
      const offset = 2
      const limit = 5
      const delegatedVotersData = await voting.getDelegatedVoters(delegate1, offset, limit)
      const delegatedVotersCount = (await voting.getDelegatedVotersCount(delegate1)).toNumber()
      const delegatedVotersCountToReturn = delegatedVotersCount - offset

      assert(delegatedVotersData[0].length === delegatedVotersCountToReturn)
      assert(delegatedVotersData[1].length === delegatedVotersCountToReturn)

      const votersSlice = voters.slice(offset, delegatedVotersCount)
      const votersListSlice = votersSlice.map(voter => voter.account)
      assertArraysEqualAsSets(delegatedVotersData[0], votersListSlice, 'votersList should be correct')

      const votingPowerListSlice = votersSlice.map((voter) => voter.balance.toString())
      const votingPowerList = delegatedVotersData[1].map(votingPower => votingPower.toString())
      assertArraysEqualAsSets(votingPowerList, votingPowerListSlice, 'votingPowerList should be correct')
    })

    it(`should return correct delegated voters data if offset + limit < votersCount`, async () => {
      const offset = 1
      const limit = 1
      const delegatedVotersData = await voting.getDelegatedVoters(delegate1, offset, limit)

      assert(delegatedVotersData[0].length === limit)
      assert(delegatedVotersData[1].length === limit)

      const votersSlice = voters.slice(offset, offset + limit)
      const votersListSlice = votersSlice.map(voter => voter.account)
      assertArraysEqualAsSets(delegatedVotersData[0], votersListSlice, 'votersList should be correct')

      const votingPowerListSlice = votersSlice.map((voter) => voter.balance.toString())
      const votingPowerList = delegatedVotersData[1].map(votingPower => votingPower.toString())
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
        await voting.setDelegate(delegate1, {from: voters[i].account})
      }

      executionTarget = await ExecutionTarget.new()

      const action = {to: executionTarget.address, calldata: executionTarget.contract.methods.execute().encodeABI()}
      script = encodeCallScript([action, action])

      await voting.resetDelegate({from: holder1})
      await token.transfer(holder51, bigExp(2, decimals), { from: holder2 })

      const receipt = await voting.methods['newVote(bytes,string)'](script, 'metadata', {from: holder51});
      voteId = getEventArgument(receipt, 'StartVote', 'voteId')
      creator = getEventArgument(receipt, 'StartVote', 'creator')
      metadata = getEventArgument(receipt, 'StartVote', 'metadata')
    })

    it(`getVotersStateAtVote`, async () => {
      await voting.vote(voteId, true, false, { from: holder20 })
      await voting.vote(voteId, false, false, { from: holder29 })
      await voting.attemptVoteForMultiple(voteId, false, [holder51], {from: delegate1})

      const votersState = await voting.getVotersStateAtVote(voteId, [holder20, holder29, holder51])
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

    it(`one of the voters voted beforehand`, async () => {
      await voting.vote(voteId, false, false, { from: holder29 })
      const tx = await voting.attemptVoteForMultiple(voteId, true, [holder20, holder29], {from: delegate1});

      assertAmountOfEvents(tx, 'CastVote', {expectedAmount: 1})
      assertAmountOfEvents(tx, 'CastVoteAsDelegate', {expectedAmount: 1})
      assertEvent(tx, 'CastVote', {expectedArgs: {voteId, voter: holder20, supports: true}})
      assertEvent(tx, 'CastVoteAsDelegate', {expectedArgs: {voteId, delegate: delegate1, voter: holder20, supports: true}})

      assert.equal(await voting.getVoterState(voteId, holder29), VOTER_STATE.NAY, `holder29 should have 'nay' state`)
      assert.equal(await voting.getVoterState(voteId, holder20), VOTER_STATE.DELEGATE_YEA, `holder20 should have 'delegateYea' state`)
    })

    it(`vote for multiple with duplicates`, async () => {
      const tx = await voting.attemptVoteForMultiple(voteId, false, [holder29, holder29], {from: delegate1});

      assertAmountOfEvents(tx, 'CastVote', {expectedAmount: 2})
      assertAmountOfEvents(tx, 'CastVoteAsDelegate', {expectedAmount: 2})
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
      const delegatedVotersData = await voting.getDelegatedVotersAtVote(delegate1, 0, 100, voteId)
      const delegatedVotersAddresses = delegatedVotersData[0]
      const delegatedVotersVotingPower = delegatedVotersData[1]
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
      assertAmountOfEvents(tx, 'CastVoteAsDelegate', {expectedAmount: filteredDelegatedVoters.length})

      // Check events content
      for (let i = 0; i < filteredDelegatedVoters.length; i++) {
        const {address, votingPower} = filteredDelegatedVoters[i]
        assertEvent(tx, 'CastVote', {index: i, expectedArgs: {voteId, voter: address, supports: false, stake: votingPower}})
        assertEvent(tx, 'CastVoteAsDelegate', {index: i, expectedArgs: {voteId, delegate: delegate1, voter: address, supports: false, stake: votingPower}})
      }

      // Check voters' state
      const votersState = await voting.getVotersStateAtVote(voteId, filteredDelegatedVotersAddresses)
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
      assertAmountOfEvents(tx, 'CastVoteAsDelegate', {expectedAmount: 1})

      const holder29VP = bigExp(29, decimals)

      // Check events content
      assertEvent(tx, 'CastVote', { expectedArgs: {voteId, voter: holder29, supports: false, stake: holder29VP}})
      assertEvent(tx, 'CastVoteAsDelegate', { expectedArgs: {voteId, delegate: delegate1, voter: holder29, supports: false, stake: holder29VP}})


      // Check voter's state
      assert.equal(await voting.getVoterState(voteId, holder29), VOTER_STATE.DELEGATE_NAY, `holder29 should have 'delegateNay' state`)

      // Check applied VP
      const vote = await voting.getVote(voteId)
      assertBn(vote.yea, bigExp(0, decimals), 'yea should be 0')
      assertBn(vote.nay, holder29VP, 'nay should be holder29 VP')
    })

  })
})
