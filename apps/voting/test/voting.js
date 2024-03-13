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

contract('Voting App', ([root, holder1, holder2, holder20, holder29, holder51, delegate1, delegate2, nonHolder]) => {
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

  context('normal token supply, common tests', () => {
    const neededSupport = pct16(50)
    const minimumAcceptanceQuorum = pct16(20)

    beforeEach(async () => {
      token = await MiniMeToken.new(ZERO_ADDRESS, ZERO_ADDRESS, 0, 'n', 0, 'n', true) // empty parameters minime
      await voting.initialize(token.address, neededSupport, minimumAcceptanceQuorum, votingDuration, objectionPhase)
      executionTarget = await ExecutionTarget.new()
    })

    it('fails on reinitialization', async () => {
      await assertRevert(voting.initialize(token.address, neededSupport, minimumAcceptanceQuorum, votingDuration,
          objectionPhase), ERRORS.INIT_ALREADY_INITIALIZED)
    })

    it('cannot initialize base app', async () => {
      const newVoting = await Voting.new()
      assert.isTrue(await newVoting.isPetrified())
      await assertRevert(newVoting.initialize(token.address, neededSupport, minimumAcceptanceQuorum, votingDuration,
          objectionPhase), ERRORS.INIT_ALREADY_INITIALIZED)
    })

    it('checks it is forwarder', async () => {
      assert.isTrue(await voting.isForwarder())
    })

    it('can change required support', async () => {
      const receipt = await voting.changeSupportRequiredPct(neededSupport.add(bn(1)))
      assertAmountOfEvents(receipt, 'ChangeSupportRequired')

      assertBn(await voting.supportRequiredPct(), neededSupport.add(bn(1)), 'should have changed required support')
    })

    it('fails changing required support lower than minimum acceptance quorum', async () => {
      await assertRevert(voting.changeSupportRequiredPct(minimumAcceptanceQuorum.sub(bn(1))), ERRORS.VOTING_CHANGE_SUPPORT_PCTS)
    })

    it('fails changing required support to 100% or more', async () => {
      await assertRevert(voting.changeSupportRequiredPct(pct16(101)), ERRORS.VOTING_CHANGE_SUPP_TOO_BIG)
      await assertRevert(voting.changeSupportRequiredPct(pct16(100)), ERRORS.VOTING_CHANGE_SUPP_TOO_BIG)
    })

    it('can change minimum acceptance quorum', async () => {
      const receipt = await voting.changeMinAcceptQuorumPct(1)
      assertAmountOfEvents(receipt, 'ChangeMinQuorum')

      assert.equal(await voting.minAcceptQuorumPct(), 1, 'should have changed acceptance quorum')
    })

    it('fails changing minimum acceptance quorum to greater than min support', async () => {
      await assertRevert(voting.changeMinAcceptQuorumPct(neededSupport.add(bn(1))), ERRORS.VOTING_CHANGE_QUORUM_PCTS)
    })

  })

  for (const decimals of [0, 2, 18, 26]) {
    context(`normal token supply, ${decimals} decimals`, () => {
      const neededSupport = pct16(50)
      const minimumAcceptanceQuorum = pct16(20)

      beforeEach(async () => {
        token = await MiniMeToken.new(ZERO_ADDRESS, ZERO_ADDRESS, 0, 'n', decimals, 'n', true) // empty parameters minime

        await token.generateTokens(holder20, bigExp(20, decimals))
        await token.generateTokens(holder29, bigExp(29, decimals))
        await token.generateTokens(holder51, bigExp(51, decimals))

        await voting.initialize(token.address, neededSupport, minimumAcceptanceQuorum, votingDuration, objectionPhase)

        executionTarget = await ExecutionTarget.new()
      })

      it('execution scripts can execute multiple actions', async () => {
        const action = { to: executionTarget.address, calldata: executionTarget.contract.methods.execute().encodeABI() }
        const script = encodeCallScript([action, action, action])

        const voteId = createdVoteId(await voting.newVote(script, '', { from: holder51 }))
        await voting.vote(voteId, true, true, { from: holder51 })
        await voting.mockIncreaseTime(votingDuration + 1)
        await voting.executeVote(voteId)

        assert.equal(await executionTarget.counter(), 3, 'should have executed multiple times')
      })

      it('execution script can be empty', async () => {
        const voteId = createdVoteId(await voting.newVote(encodeCallScript([]), '', { from: holder51 }))
        await voting.vote(voteId, true, true, { from: holder51 })
        await voting.mockIncreaseTime(votingDuration + 1)
        await voting.executeVote(voteId)
      })

      it('check castVote do nothing (deprecated)', async () => {
        let voteId = createdVoteId(await voting.methods['newVote(bytes,string,bool,bool)'](encodeCallScript([]), '', true, false, { from: holder51 }))
        assert.equal(await voting.getVoterState(voteId, holder51), VOTER_STATE.ABSENT, 'holder51 should not have voted')
      })

      it('check executesIfDecided do nothing (deprecated)', async () => {
        let voteId = createdVoteId(await voting.methods['newVote(bytes,string,bool,bool)'](encodeCallScript([]), '', true, false, { from: holder51 }))
        await voting.vote(voteId, true, true, { from: holder51 })
        assert.equal(await voting.canExecute(voteId), false, 'should be in the unexecuted state')
        await voting.mockIncreaseTime(votingDuration + 1)
        await voting.executeVote(voteId)
        assert.equal(await voting.canExecute(voteId), false, 'should be in the executed state')

        voteId = createdVoteId(await voting.methods['newVote(bytes,string,bool,bool)'](encodeCallScript([]), '', true, true, { from: holder51 }))
        await voting.vote(voteId, true, true, { from: holder51 })
        assert.equal(await voting.canExecute(voteId), false, 'should be in the unexecuted state')
        await voting.mockIncreaseTime(votingDuration + 1)
        await voting.executeVote(voteId)
        assert.equal(await voting.canExecute(voteId), false, 'should be in the executed state')
      })

      it('execution throws if any action on script throws', async () => {
        const action = { to: executionTarget.address, calldata: executionTarget.contract.methods.execute().encodeABI() }
        let script = encodeCallScript([action])
        script = script.slice(0, -2) // remove one byte from calldata for it to fail

        const voteId = createdVoteId(await voting.newVote(script, '', { from: holder51 }))
        await voting.mockIncreaseTime(votingDuration + 1)
        await assertRevert(voting.executeVote(voteId))
      })

      it('forwarding creates vote', async () => {
        const action = { to: executionTarget.address, calldata: executionTarget.contract.methods.execute().encodeABI() }
        const script = encodeCallScript([action])
        const voteId = createdVoteId(await voting.forward(script, { from: holder51 }))
        assert.equal(voteId, 0, 'voting should have been created')
      })

      context('creating vote', () => {
        let script, voteId, creator, metadata

        beforeEach(async () => {
          const action = { to: executionTarget.address, calldata: executionTarget.contract.methods.execute().encodeABI() }
          script = encodeCallScript([action, action])

          const receipt = await voting.methods['newVote(bytes,string,bool,bool)'](script, 'metadata', false, false, { from: holder51 })
          voteId = getEventArgument(receipt, 'StartVote', 'voteId')
          creator = getEventArgument(receipt, 'StartVote', 'creator')
          metadata = getEventArgument(receipt, 'StartVote', 'metadata')
        })

        it('has correct state', async () => {
          const { open, executed, snapshotBlock, supportRequired, minAcceptQuorum, yea, nay, votingPower, script: execScript } = await voting.getVote(voteId)
          assert.isTrue(open, 'vote should be open')
          assert.isFalse(executed, 'vote should not be executed')
          assert.equal(creator, holder51, 'creator should be correct')
          assertBn(snapshotBlock, await web3.eth.getBlockNumber() - 1, 'snapshot block should be correct')
          assertBn(supportRequired, neededSupport, 'required support should be app required support')
          assertBn(minAcceptQuorum, minimumAcceptanceQuorum, 'min quorum should be app min quorum')
          assertBn(yea, 0, 'initial yea should be 0')
          assertBn(nay, 0, 'initial nay should be 0')
          assertBn(votingPower, bigExp(100, decimals), 'voting power should be 100')
          assert.equal(execScript, script, 'script should be correct')
          assert.equal(metadata, 'metadata', 'should have returned correct metadata')
          assert.equal(await voting.getVoterState(voteId, nonHolder), VOTER_STATE.ABSENT, 'nonHolder should not have voted')
        })

        it('fails getting a vote out of bounds', async () => {
          await assertRevert(voting.getVote(voteId + 1), ERRORS.VOTING_NO_VOTE)
        })

        it('changing required support does not affect vote required support', async () => {
          await voting.changeSupportRequiredPct(pct16(70))

          // With previous required support at 50%, vote should be approved
          // with new quorum at 70% it shouldn't have, but since min quorum is snapshotted
          // it will succeed

          await voting.vote(voteId, true, false, { from: holder51 })
          await voting.vote(voteId, true, false, { from: holder20 })
          await voting.vote(voteId, false, false, { from: holder29 })
          await voting.mockIncreaseTime(votingDuration + 1)

          const state = await voting.getVote(voteId)
          assertBn(state[4], neededSupport, 'required support in vote should stay equal')
          await voting.executeVote(voteId) // exec doesn't fail
        })

        it('changing min quorum doesnt affect vote min quorum', async () => {
          await voting.changeMinAcceptQuorumPct(pct16(50))

          // With previous min acceptance quorum at 20%, vote should be approved
          // with new quorum at 50% it shouldn't have, but since min quorum is snapshotted
          // it will succeed

          const tx = await voting.vote(voteId, true, true, { from: holder29 })
          assertEvent(tx, 'CastVote', { expectedArgs: { voteId: voteId, voter: holder29, supports: true }})
          assertAmountOfEvents(tx, 'CastVote', { expectedAmount: 1 })
          assertAmountOfEvents(tx, 'CastObjection', { expectedAmount: 0 })

          await voting.mockIncreaseTime(votingDuration + 1)

          const state = await voting.getVote(voteId)
          assertBn(state[5], minimumAcceptanceQuorum, 'acceptance quorum in vote should stay equal')
          await voting.executeVote(voteId) // exec doesn't fail
        })

        it('holder can vote', async () => {
          const tx = await voting.vote(voteId, false, true, { from: holder29 })
          assertEvent(tx, 'CastVote', { expectedArgs: { voteId: voteId, voter: holder29, supports: false }})
          assertAmountOfEvents(tx, 'CastVote', { expectedAmount: 1 })
          assertAmountOfEvents(tx, 'CastObjection', { expectedAmount: 0 })

          const state = await voting.getVote(voteId)
          const voterState = await voting.getVoterState(voteId, holder29)

          assertBn(state[7], bigExp(29, decimals), 'nay vote should have been counted')
          assert.equal(voterState, VOTER_STATE.NAY, 'holder29 should have nay voter status')
        })

        it('holder can object', async () => {
          await voting.mockIncreaseTime(mainPhase + 1)
          await assertRevert(voting.vote(voteId, true, false, { from: holder29 }), ERRORS.VOTING_CAN_NOT_VOTE)
          await assertRevert(voting.vote(voteId, true, true, { from: holder29 }), ERRORS.VOTING_CAN_NOT_VOTE)
          ;({
              open, executed, startDate, snapshotBlock, supportRequired, minAcceptQuorum,
              yea, nay, votingPower, script, phase
            } = await voting.getVote(voteId))
          assert.equal(yea, 0, 'should be no votes yet')
          assert.equal(nay, 0, 'should be no votes yet')

          let tx = await voting.vote(voteId, false, false, { from: holder29 })
          assertEvent(tx, 'CastVote', { expectedArgs: { voteId: voteId, voter: holder29, supports: false }})
          assertEvent(tx, 'CastObjection', { expectedArgs: { voteId: voteId, voter: holder29 }})
          assertAmountOfEvents(tx, 'CastVote', { expectedAmount: 1 })
          assertAmountOfEvents(tx, 'CastObjection', { expectedAmount: 1 })

          ;({
            open, executed, startDate, snapshotBlock, supportRequired, minAcceptQuorum,
            yea, nay, votingPower, script, phase
          } = await voting.getVote(voteId))
          assert.equal(yea, 0, 'should be no yea votes')
          assert.notEqual(nay, 0, 'should some nay votes')
          const nayBefore = nay

          await assertRevert(voting.vote(voteId, true, false, { from: holder29 }), ERRORS.VOTING_CAN_NOT_VOTE)
          tx = await voting.vote(voteId, false, false, { from: holder29 })
          assertEvent(tx, 'CastVote', { expectedArgs: { voteId: voteId, voter: holder29, supports: false }})
          assertEvent(tx, 'CastObjection', { expectedArgs: { voteId: voteId, voter: holder29 }})
          assertAmountOfEvents(tx, 'CastVote', { expectedAmount: 1 })
          assertAmountOfEvents(tx, 'CastObjection', { expectedAmount: 1 })

          assert.equal(yea, 0, 'should be no yea votes')
          assert.equal(nay, nayBefore, 'should be same nay votes')

          await voting.mockIncreaseTime(objectionPhase)
        })

        it('canVote check works', async () => {
          assert.equal(await voting.canVote(voteId, holder29), true, 'should be able to vote')
          await voting.mockIncreaseTime(mainPhase + 1)
          assert.equal(await voting.canVote(voteId, holder29), true, 'should be unable to vote')
          await voting.mockIncreaseTime(objectionPhase)
          assert.equal(await voting.canVote(voteId, holder29), false, 'should be unable to vote')
        })

        it('getVotePhase works', async () => {
          const extractPhaseFromGetVote = async (voteId) => {
            const phaseIndex = 10
            return (await voting.getVote(voteId))[phaseIndex]
          }

          const MAIN_PHASE = 0
          assert.equal(await voting.getVotePhase(voteId), MAIN_PHASE, 'should be main phase')
          assert.equal(await extractPhaseFromGetVote(voteId), MAIN_PHASE, 'should be main phase')

          await voting.mockIncreaseTime(mainPhase + 1)
          const OBJECTION_PHASE = 1
          assert.equal(await voting.getVotePhase(voteId), OBJECTION_PHASE, 'should be objection phase')
          assert.equal(await extractPhaseFromGetVote(voteId), OBJECTION_PHASE, 'should be objection phase')

          await voting.mockIncreaseTime(objectionPhase)
          const CLOSED = 2
          assert.equal(await voting.getVotePhase(voteId), CLOSED, 'should be closed vote')
          assert.equal(await extractPhaseFromGetVote(voteId), CLOSED, 'should be closed vote')
        })

        it('holder can modify vote', async () => {
          let tx = await voting.vote(voteId, true, true, { from: holder29 })
          assertEvent(tx, 'CastVote', { expectedArgs: { voteId: voteId, voter: holder29, supports: true }})
          assertAmountOfEvents(tx, 'CastVote', { expectedAmount: 1 })
          assertAmountOfEvents(tx, 'CastObjection', { expectedAmount: 0 })

          tx = await voting.vote(voteId, false, true, { from: holder29 })
          assertEvent(tx, 'CastVote', { expectedArgs: { voteId: voteId, voter: holder29, supports: false }})
          assertAmountOfEvents(tx, 'CastVote', { expectedAmount: 1 })
          assertAmountOfEvents(tx, 'CastObjection', { expectedAmount: 0 })

          tx = await voting.vote(voteId, true, true, { from: holder29 })
          assertEvent(tx, 'CastVote', { expectedArgs: { voteId: voteId, voter: holder29, supports: true }})
          assertAmountOfEvents(tx, 'CastVote', { expectedAmount: 1 })
          assertAmountOfEvents(tx, 'CastObjection', { expectedAmount: 0 })

          const state = await voting.getVote(voteId)

          assertBn(state[6], bigExp(29, decimals), 'yea vote should have been counted')
          assert.equal(state[7], 0, 'nay vote should have been removed')
        })

        it('token transfers dont affect voting', async () => {
          await token.transfer(nonHolder, bigExp(29, decimals), { from: holder29 })

          await voting.vote(voteId, true, true, { from: holder29 })
          const state = await voting.getVote(voteId)

          assertBn(state[6], bigExp(29, decimals), 'yea vote should have been counted')
          assert.equal(await token.balanceOf(holder29), 0, 'balance should be 0 at current block')
        })

        it('throws when non-holder votes', async () => {
          await assertRevert(voting.vote(voteId, true, true, { from: nonHolder }), ERRORS.VOTING_NO_VOTING_POWER)
        })

        it('throws when voting after voting closes', async () => {
          await voting.mockIncreaseTime(votingDuration + 1)
          await assertRevert(voting.vote(voteId, true, true, { from: holder29 }), ERRORS.VOTING_CAN_NOT_VOTE)
        })

        it('can execute if vote is approved with support and quorum', async () => {
          await voting.vote(voteId, true, true, { from: holder29 })
          await voting.vote(voteId, false, true, { from: holder20 })
          await voting.mockIncreaseTime(votingDuration + 1)
          await voting.executeVote(voteId)
          assert.equal(await executionTarget.counter(), 2, 'should have executed result')
        })

        it('cannot execute vote if not enough quorum met', async () => {
          await voting.vote(voteId, true, true, { from: holder20 })
          await voting.mockIncreaseTime(votingDuration + 1)
          await assertRevert(voting.executeVote(voteId), ERRORS.VOTING_CAN_NOT_EXECUTE)
        })

        it('cannot execute vote if not support met', async () => {
          await voting.vote(voteId, false, true, { from: holder29 })
          await voting.vote(voteId, false, true, { from: holder20 })
          await voting.mockIncreaseTime(votingDuration + 1)
          await assertRevert(voting.executeVote(voteId), ERRORS.VOTING_CAN_NOT_EXECUTE)
        })

        it('vote isnot executed automatically if decided', async () => {
          await voting.vote(voteId, true, false, { from: holder51 }) // doesnt cause execution
          assert.equal(await executionTarget.counter(), 0, 'should not have executed result')
        })

        it('cannot re-execute vote', async () => {
          await voting.vote(voteId, true, true, { from: holder51 })
          await voting.mockIncreaseTime(votingDuration + 1)
          await voting.executeVote(voteId)

          await assertRevert(voting.executeVote(voteId), ERRORS.VOTING_CAN_NOT_EXECUTE)
        })

        it('cannot vote on executed vote', async () => {
          await voting.vote(voteId, true, true, { from: holder51 })
          await voting.mockIncreaseTime(votingDuration + 1)
          await voting.executeVote(voteId)

          await assertRevert(voting.vote(voteId, true, true, { from: holder20 }), ERRORS.VOTING_CAN_NOT_VOTE)
        })
      })
    })

    context('voting for', () => {
      let script, voteId, creator, metadata

      const neededSupport = pct16(50)
      const minimumAcceptanceQuorum = pct16(20)

      beforeEach(async () => {
        token = await MiniMeToken.new(ZERO_ADDRESS, ZERO_ADDRESS, 0, 'n', decimals, 'n', true) // empty parameters minime

        await token.generateTokens(holder20, bigExp(20, decimals))
        await token.generateTokens(holder29, bigExp(29, decimals))
        await token.generateTokens(holder51, bigExp(51, decimals))
        await voting.initialize(token.address, neededSupport, minimumAcceptanceQuorum, votingDuration, 0)
        await voting.setDelegate(delegate1, {from: holder29})
        await voting.setDelegate(delegate1, {from: holder51})

        executionTarget = await ExecutionTarget.new()

        const action = {to: executionTarget.address, calldata: executionTarget.contract.methods.execute().encodeABI()}
        script = encodeCallScript([action, action])

        const receipt = await voting.methods['newVote(bytes,string,bool,bool)'](script, 'metadata', false, false, {from: holder51});
        voteId = getEventArgument(receipt, 'StartVote', 'voteId')
        creator = getEventArgument(receipt, 'StartVote', 'creator')
        metadata = getEventArgument(receipt, 'StartVote', 'metadata')
      })


      it('delegate can vote for voter', async () => {
        const tx = await voting.attemptVoteFor(voteId, false, holder29, {from: delegate1})
        assertEvent(tx, 'CastVote', {expectedArgs: {voteId: voteId, voter: holder29, supports: false}})
        assertEvent(tx, 'CastVoteAsDelegate', {expectedArgs: {voteId: voteId, delegate: delegate1, voter: holder29, supports: false}})
        assertAmountOfEvents(tx, 'CastVote', {expectedAmount: 1})
        assertAmountOfEvents(tx, 'CastObjection', {expectedAmount: 0})
        assertAmountOfEvents(tx, 'CastVoteAsDelegate', {expectedAmount: 1})

        const state = await voting.getVote(voteId)
        const voterState = await voting.getVoterState(voteId, holder29)

        assertBn(state[7], bigExp(29, decimals), 'nay vote should have been counted')
        assert.equal(voterState, VOTER_STATE.DELEGATE_NAY, 'holder29 should have delegate nay voter status')
      })

      it('delegate can vote for both voters', async () => {
        const tx = await voting.attemptVoteForMultiple(voteId, false, [holder29, holder51], {from: delegate1})
        assertEvent(tx, 'CastVote', {expectedArgs: {voteId: voteId, voter: holder29, supports: false}})
        assertEvent(tx, 'CastVote', {index: 1, expectedArgs: {voteId: voteId, voter: holder51, supports: false}})
        assertEvent(tx, 'CastVoteAsDelegate', {expectedArgs: {voteId: voteId, delegate: delegate1, voter: holder29, supports: false}})
        assertEvent(tx, 'CastVoteAsDelegate', {index: 1, expectedArgs: {voteId: voteId, delegate: delegate1, voter: holder51, supports: false}})
        assertAmountOfEvents(tx, 'CastVote', {expectedAmount: 2})
        assertAmountOfEvents(tx, 'CastObjection', {expectedAmount: 0})
        assertAmountOfEvents(tx, 'CastVoteAsDelegate', {expectedAmount: 2})

        const state = await voting.getVote(voteId)
        assertBn(state[7], bigExp(80, decimals), 'nay vote should have been counted')

        const voterState29 = await voting.getVoterState(voteId, holder29)
        assert.equal(voterState29, VOTER_STATE.DELEGATE_NAY, 'holder29 should have delegate nay voter status')

        const voterState51 = await voting.getVoterState(voteId, holder51)
        assert.equal(voterState51, VOTER_STATE.DELEGATE_NAY, 'holder51 should have delegate nay voter status')
      })

      it(`revert if both voters has voted before`, async () => {
        await voting.vote(voteId, false, true, { from: holder29 })
        await voting.vote(voteId, false, true, { from: holder51 })
        await assertRevert(
          voting.attemptVoteForMultiple(voteId, false, [holder29, holder51], {from: delegate1}),
          ERRORS.VOTING_CAN_NOT_VOTE_FOR
        )
      })

      it(`delegate can vote for one of the two if the other one has voted before`, async () => {
        await voting.vote(voteId, false, true, { from: holder51 })
        const tx = await voting.attemptVoteForMultiple(voteId, false, [holder29, holder51], {from: delegate1})
        assertEvent(tx, 'CastVoteAsDelegate', {expectedArgs: {voteId: voteId, delegate: delegate1, voter: holder29, supports: false}})
        assertAmountOfEvents(tx, 'CastVoteAsDelegate', {expectedAmount: 1})
      })

      it(`voter can overwrite delegate's vote`, async () => {
        await voting.attemptVoteFor(voteId, false, holder29, {from: delegate1})

        const tx = await voting.vote(voteId, true, true, {from: holder29})
        assertEvent(tx, 'CastVote', {expectedArgs: {voteId: voteId, voter: holder29, supports: true}})
        assertAmountOfEvents(tx, 'CastVote', {expectedAmount: 1})
        assertAmountOfEvents(tx, 'CastObjection', {expectedAmount: 0})

        const state = await voting.getVote(voteId)
        assertBn(state[6], bigExp(29, decimals), 'yea vote should have been counted')
        assertBn(state[7], bigExp(0, decimals), 'nay vote should have been reset')

        const voterState29 = await voting.getVoterState(voteId, holder29)
        assert.equal(voterState29, VOTER_STATE.YEA, 'holder29 should have yea voter status')
      })

      it(`delegate can't overwrite voter's vote`, async () => {
        await voting.attemptVoteFor(voteId, false, holder29, {from: delegate1})
        await voting.vote(voteId, true, true, {from: holder29})

        await assertRevert(
            voting.attemptVoteFor(
                voteId,
                false,
                holder29,
                { from: delegate1 }
            ), ERRORS.VOTING_CAN_NOT_VOTE_FOR
        )
      })
    })
  }

  context('wrong initializations', () => {
    beforeEach(async() => {
      token = await MiniMeToken.new(ZERO_ADDRESS, ZERO_ADDRESS, 0, 'n', 0, 'n', true) // empty parameters minime
    })

    it('fails if voteTime less or equal to objectionTime', async () => {
      let badVoteTime = objectionPhase
      const neededSupport = pct16(50)
      const minimumAcceptanceQuorum = pct16(20)

      await assertRevert(
        voting.initialize(
          token.address,
          neededSupport,
          minimumAcceptanceQuorum,
          badVoteTime,
          objectionPhase
        ), ERRORS.VOTING_INIT_OBJ_TIME_TOO_BIG
      )

      badVoteTime = objectionPhase / 2
      await assertRevert(
        voting.initialize(
          token.address,
          neededSupport,
          minimumAcceptanceQuorum,
          badVoteTime,
          objectionPhase
        ), ERRORS.VOTING_INIT_OBJ_TIME_TOO_BIG
      )
    })

    it('fails if min acceptance quorum is greater than min support', async () => {
      const neededSupport = pct16(20)
      const minimumAcceptanceQuorum = pct16(50)
      await assertRevert(voting.initialize(token.address, neededSupport, minimumAcceptanceQuorum, votingDuration,
          objectionPhase), ERRORS.VOTING_INIT_PCTS)
    })

    it('fails if min support is 100% or more', async () => {
      const minimumAcceptanceQuorum = pct16(20)
      await assertRevert(voting.initialize(token.address, pct16(101), minimumAcceptanceQuorum, votingDuration,
          objectionPhase), ERRORS.VOTING_INIT_SUPPORT_TOO_BIG)
      await assertRevert(voting.initialize(token.address, pct16(100), minimumAcceptanceQuorum, votingDuration,
          objectionPhase), ERRORS.VOTING_INIT_SUPPORT_TOO_BIG)
    })
  })

  context('empty token', () => {
    const neededSupport = pct16(50)
    const minimumAcceptanceQuorum = pct16(20)

    beforeEach(async() => {
      token = await MiniMeToken.new(ZERO_ADDRESS, ZERO_ADDRESS, 0, 'n', 0, 'n', true) // empty parameters minime

      await voting.initialize(token.address, neededSupport, minimumAcceptanceQuorum, votingDuration, objectionPhase)
    })

    it('fails creating a vote if token has no holder', async () => {
      await assertRevert(voting.newVote(EMPTY_CALLS_SCRIPT, 'metadata'), ERRORS.VOTING_NO_VOTING_POWER)
    })
  })

  context('token supply = 1', () => {
    const neededSupport = pct16(50)
    const minimumAcceptanceQuorum = pct16(20)

    beforeEach(async () => {
      token = await MiniMeToken.new(ZERO_ADDRESS, ZERO_ADDRESS, 0, 'n', 0, 'n', true) // empty parameters minime

      await token.generateTokens(holder1, 1)

      await voting.initialize(token.address, neededSupport, minimumAcceptanceQuorum, votingDuration, objectionPhase)
    })

    it('new vote cannot be executed before voting', async () => {
      // Account creating vote does not have any tokens and therefore doesn't vote
      const voteId = createdVoteId(await voting.newVote(EMPTY_CALLS_SCRIPT, 'metadata'))

      assert.isFalse(await voting.canExecute(voteId), 'vote cannot be executed')

      await voting.vote(voteId, true, true, { from: holder1 })
      assert.isFalse(await voting.canExecute(voteId), 'vote cannot be executed')

      await voting.mockIncreaseTime(votingDuration + 1)
      assert.isTrue(await voting.canExecute(voteId), 'vote may be executed')

      await voting.executeVote(voteId)

      const { open, executed } = await voting.getVote(voteId)
      assert.isFalse(open, 'vote should be closed')
      assert.isTrue(executed, 'vote should have been executed')

    })

    context('new vote parameters', () => {
      it('creating vote as holder does not execute vote (even if _canExecute param says so)', async () => {
        const voteId = createdVoteId(await voting.methods['newVote(bytes,string,bool,bool)'](EMPTY_CALLS_SCRIPT, 'metadata', true, true, { from: holder1 }))

        const { open, executed } = await voting.getVote(voteId)
        assert.isTrue(open, 'vote should be closed')
        assert.isFalse(executed, 'vote should have been executed')
      })

      it("creating vote as holder doesn't execute vote if _canExecute param doesn't says so", async () => {
        const voteId = createdVoteId(await voting.methods['newVote(bytes,string,bool,bool)'](EMPTY_CALLS_SCRIPT, 'metadata', true, false, { from: holder1 }))

        const { open, executed } = await voting.getVote(voteId)
        assert.isTrue(open, 'vote should be open')
        assert.isFalse(executed, 'vote should not have been executed')
      })
    })
  })

  context('token supply = 3', () => {
    const neededSupport = pct16(34)
    const minimumAcceptanceQuorum = pct16(20)

    beforeEach(async () => {
      token = await MiniMeToken.new(ZERO_ADDRESS, ZERO_ADDRESS, 0, 'n', 0, 'n', true) // empty parameters minime

      await token.generateTokens(holder1, 1)
      await token.generateTokens(holder2, 2)

      await voting.initialize(token.address, neededSupport, minimumAcceptanceQuorum, votingDuration, objectionPhase)
    })

    it('new vote cannot be executed before holder2 voting and time pass', async () => {
      const voteId = createdVoteId(await voting.newVote(EMPTY_CALLS_SCRIPT, 'metadata'))
      assert.isFalse(await voting.canExecute(voteId), 'vote cannot be executed')
      assert.isFalse((await voting.getVote(voteId)).executed, 'vote should not have been executed')

      await voting.vote(voteId, true, true, { from: holder1 })
      assert.isFalse(await voting.canExecute(voteId), 'vote cannot be executed')
      assert.isFalse((await voting.getVote(voteId)).executed, 'vote should not have been executed')

      await voting.vote(voteId, true, true, { from: holder2 })
      assert.isFalse(await voting.canExecute(voteId), 'vote cannot be executed')
      assert.isFalse((await voting.getVote(voteId)).executed, 'vote should not have been executed')

      await voting.mockIncreaseTime(votingDuration + 1)
      assert.isTrue(await voting.canExecute(voteId), 'vote may be executed')

      await voting.executeVote(voteId)

      const { open, executed } = await voting.getVote(voteId)
      assert.isFalse(open, 'vote should be closed')
      assert.isTrue(executed, 'vote should have been executed')
    })

    it('creating vote as holder2 does not execute vote', async () => {
      const voteId = createdVoteId(await voting.newVote(EMPTY_CALLS_SCRIPT, 'metadata', { from: holder2 }))

      const { open, executed } = await voting.getVote(voteId)
      assert.isTrue(open, 'vote should be closed')
      assert.isFalse(executed, 'vote should have been executed')
    })
  })

  context('changing token supply', () => {
    const neededSupport = pct16(50)
    const minimumAcceptanceQuorum = pct16(20)

    beforeEach(async () => {
      token = await MiniMeToken.new(ZERO_ADDRESS, ZERO_ADDRESS, 0, 'n', 0, 'n', true) // empty parameters minime

      await token.generateTokens(holder1, 1)
      await token.generateTokens(holder2, 1)

      await voting.initialize(token.address, neededSupport, minimumAcceptanceQuorum, votingDuration, objectionPhase)
    })

    it('uses the correct snapshot value if tokens are minted afterwards', async () => {
      // Create vote and afterwards generate some tokens
      const voteId = createdVoteId(await voting.newVote(EMPTY_CALLS_SCRIPT, 'metadata'))
      await token.generateTokens(holder2, 1)

      const { snapshotBlock, votingPower } = await voting.getVote(voteId)

      // Generating tokens advanced the block by one
      assertBn(snapshotBlock, await web3.eth.getBlockNumber() - 2, 'snapshot block should be correct')
      assertBn(votingPower, await token.totalSupplyAt(snapshotBlock), 'voting power should match snapshot supply')
      assertBn(votingPower, 2, 'voting power should be correct')
    })

    it('uses the correct snapshot value if tokens are minted in the same block', async () => {
      // Create vote and generate some tokens in the same transaction
      // Requires the voting mock to be the token's owner
      await token.changeController(voting.address)
      const voteId = createdVoteId(await voting.newTokenAndVote(holder2, 1, 'metadata'))

      const { snapshotBlock, votingPower } = await voting.getVote(voteId)
      assertBn(snapshotBlock, await web3.eth.getBlockNumber() - 1, 'snapshot block should be correct')
      assertBn(votingPower, await token.totalSupplyAt(snapshotBlock), 'voting power should match snapshot supply')
      assertBn(votingPower, 2, 'voting power should be correct')
    })
  })

  context('before init', () => {
    it('fails creating a vote before initialization', async () => {
      await assertRevert(voting.newVote(encodeCallScript([]), ''), ERRORS.APP_AUTH_FAILED)
    })

    it('fails to forward actions before initialization', async () => {
      const action = { to: executionTarget.address, calldata: executionTarget.contract.methods.execute().encodeABI() }
      const script = encodeCallScript([action])
      await assertRevert(voting.forward(script, { from: holder51 }), ERRORS.VOTING_CAN_NOT_FORWARD)
    })
  })

  context('isValuePct unit test', async () => {
    it('tests total = 0', async () => {
      const result1 = await voting.isValuePct(0, 0, pct16(50))
      assert.equal(result1, false, "total 0 should always return false")
      const result2 = await voting.isValuePct(1, 0, pct16(50))
      assert.equal(result2, false, "total 0 should always return false")
    })

    it('tests value = 0', async () => {
      const result1 = await voting.isValuePct(0, 10, pct16(50))
      assert.equal(result1, false, "value 0 should false if pct is non-zero")
      const result2 = await voting.isValuePct(0, 10, 0)
      assert.equal(result2, false, "value 0 should return false if pct is zero")
    })

    it('tests pct ~= 100', async () => {
      const result1 = await voting.isValuePct(10, 10, pct16(100).sub(bn(1)))
      assert.equal(result1, true, "value 10 over 10 should pass")
    })

    it('tests strict inequality', async () => {
      const result1 = await voting.isValuePct(10, 20, pct16(50))
      assert.equal(result1, false, "value 10 over 20 should not pass for 50%")

      const result2 = await voting.isValuePct(pct16(50).sub(bn(1)), pct16(100), pct16(50))
      assert.equal(result2, false, "off-by-one down should not pass")

      const result3 = await voting.isValuePct(pct16(50).add(bn(1)), pct16(100), pct16(50))
      assert.equal(result3, true, "off-by-one up should pass")
    })
  })

  context('unsafe time change', () => {
    const neededSupport = pct16(1)
    const minimumAcceptanceQuorum = pct16(1)

    beforeEach(async () => {
      token = await MiniMeToken.new(ZERO_ADDRESS, ZERO_ADDRESS, 0, 'n', 18, 'n', true)
      await token.generateTokens(holder20, bigExp(20, 18))
      await token.generateTokens(holder29, bigExp(29, 18))
      await token.generateTokens(holder51, bigExp(51, 18))
      await voting.initialize(token.address, neededSupport, minimumAcceptanceQuorum, votingDuration, 0)
      executionTarget = await ExecutionTarget.new()
    })

    it('reverts on non-authorized vote time change request', async () => {
      await aclP.revokePermission(ANY_ENTITY, voting.address, UNSAFELY_MODIFY_VOTE_TIME_ROLE, { from: root })

      const entities = [nonHolder, holder1, holder29, holder51]

      for (ind = 0; ind < entities.length; ++ind) {
        await assertRevert(voting.unsafelyChangeVoteTime(500, { from: entities[ind] }), 'APP_AUTH_FAILED')
      }
    })

    it('simple change vote time', async () => {
      const smallest = 1
      const increasingTime = 1500
      const decreasingTime = 500

      // Allow to setting to smallest
      receipt = await voting.unsafelyChangeVoteTime(smallest)
      assertAmountOfEvents(receipt, 'ChangeVoteTime')
      assert.equal(await voting.voteTime(), smallest, 'should have changed acceptance time')

      // Allow to increasing voteTime
      receipt = await voting.unsafelyChangeVoteTime(increasingTime)
      assertAmountOfEvents(receipt, 'ChangeVoteTime')
      assert.equal(await voting.voteTime(), increasingTime, 'should have changed acceptance time')

      // Allow to decreasing voteTime
      receipt = await voting.unsafelyChangeVoteTime(decreasingTime)
      assertAmountOfEvents(receipt, 'ChangeVoteTime')
      assert.equal(await voting.voteTime(), decreasingTime, 'should have changed acceptance time')
    })

    it('reverts on non-authorized obj time change request', async () => {
      await aclP.revokePermission(ANY_ENTITY, voting.address, UNSAFELY_MODIFY_VOTE_TIME_ROLE, { from: root })

      const entities = [nonHolder, holder1, holder29, holder51]

      for (ind = 0; ind < entities.length; ++ind) {
        await assertRevert(voting.unsafelyChangeObjectionPhaseTime(100, { from: entities[ind] }), 'APP_AUTH_FAILED')
      }
    })

    it('simple change obj time', async () => {
      const increasingTime = 999
      const zeroTime = 0
      const decreasingTime = 500

      // Allow to setting to zero
      receipt = await voting.unsafelyChangeObjectionPhaseTime(increasingTime)
      assertAmountOfEvents(receipt, 'ChangeObjectionPhaseTime')
      assert.equal(await voting.objectionPhaseTime(), increasingTime, 'should have changed acceptance time')

      // Allow to increasing voteTime
      receipt = await voting.unsafelyChangeObjectionPhaseTime(zeroTime)
      assertAmountOfEvents(receipt, 'ChangeObjectionPhaseTime')
      assert.equal(await voting.objectionPhaseTime(), zeroTime, 'should have changed acceptance time')

      // Allow to decreasing voteTime
      receipt = await voting.unsafelyChangeObjectionPhaseTime(decreasingTime)
      assertAmountOfEvents(receipt, 'ChangeObjectionPhaseTime')
      assert.equal(await voting.objectionPhaseTime(), decreasingTime, 'should have changed acceptance time')
    })

    it('reverts if voteTime < objectionTime', async () => {
      await assertRevert(voting.unsafelyChangeObjectionPhaseTime(votingDuration + 1), ERRORS.VOTING_OBJ_TIME_TOO_BIG)

      await voting.unsafelyChangeObjectionPhaseTime(votingDuration - 1)

      await assertRevert(voting.unsafelyChangeVoteTime(votingDuration - 1), ERRORS.VOTING_VOTE_TIME_TOO_SMALL)
      await assertRevert(voting.unsafelyChangeVoteTime(0), ERRORS.VOTING_VOTE_TIME_TOO_SMALL)
    })

    it('re-open finished vote through changing of voting time', async () => {
      await voting.unsafelyChangeVoteTime(1000)

      const voteId = createdVoteId(await voting.newVote(EMPTY_CALLS_SCRIPT, 'metadata'))
      await voting.mockIncreaseTime(1001)
      voteState = await voting.getVote(voteId)

      assert.isFalse(voteState[0], 'vote should be closed')
      assert.isFalse(voteState[1], 'vote should not be executed')

      await voting.unsafelyChangeVoteTime(1500)
      voteState = await voting.getVote(voteId)

      assert.isTrue(voteState[0], 'vote should be open after increasing of voting time')
      assert.isFalse(voteState[1], 'vote should not be executed')
    })

    it('close vote through changing of voting time', async () => {
      await voting.unsafelyChangeVoteTime(1500)

      const voteId = createdVoteId(await voting.newVote(EMPTY_CALLS_SCRIPT, 'metadata'))
      voteState = await voting.getVote(voteId)

      await voting.mockIncreaseTime(1001)

      assert.isTrue(voteState[0], 'vote should be open')
      assert.isFalse(voteState[1], 'vote should not be executed')

      await voting.unsafelyChangeVoteTime(1)
      voteState = await voting.getVote(voteId)

      assert.isFalse(voteState[0], 'vote should be closed after time decreasing')
      assert.isFalse(voteState[1], 'vote should not be executed')
    })

    it('changing time does not affect executed votes', async () => {
      await voting.unsafelyChangeVoteTime(1000)

      const voteId = createdVoteId(await voting.newVote(EMPTY_CALLS_SCRIPT, 'metadata'))
      await voting.vote(voteId, true, false, { from: holder20 })
      await voting.vote(voteId, true, false, { from: holder29 })
      await voting.vote(voteId, true, false, { from: holder51 })
      await voting.mockIncreaseTime(1001 + objectionPhase)
      await voting.executeVote(voteId)

      voteState = await voting.getVote(voteId)

      assert.isFalse(voteState[0], 'vote should be closed after execution')
      assert.isTrue(voteState[1], 'vite should be executed')

      await voting.unsafelyChangeVoteTime(1500)
      voteState = await voting.getVote(voteId)

      assert.isFalse(voteState[0], 'vote should be closed after time increasing')
      assert.isTrue(voteState[1], 'vite should be executed')
    })
  })

  context('voting delegate', () => {
    const neededSupport = pct16(50)
    const minimumAcceptanceQuorum = pct16(20)
    const decimals = 18

    beforeEach(async () => {
      token = await MiniMeToken.new(ZERO_ADDRESS, ZERO_ADDRESS, 0, 'n', decimals, 'n', true) // empty parameters minime

      await token.generateTokens(holder20, bigExp(20, decimals))
      await token.generateTokens(holder29, bigExp(29, decimals))
      await token.generateTokens(holder51, bigExp(51, decimals))
      await token.generateTokens(holder1, bigExp(1, decimals))
      await voting.initialize(token.address, neededSupport, minimumAcceptanceQuorum, votingDuration, 0)

      executionTarget = await ExecutionTarget.new()
    })

    it('voter can set delegate', async () => {
      const tx = await voting.setDelegate(delegate1, {from: holder29})
      assertEvent(tx, 'SetDelegate', {
        expectedArgs: {voter: holder29, delegate: delegate1}
      })
      assertAmountOfEvents(tx, 'SetDelegate', {expectedAmount: 1})

      const delegate = await voting.getDelegate(holder29)
      assert.equal(delegate, delegate1, 'holder29 should have delegate1 as a delegate')

      const delegatedVoters = (await voting.getDelegatedVoters(delegate1, 0, 1))[0]
      assertArraysEqualAsSets(delegatedVoters, [holder29], 'delegate1 should be a delegate of holder29')
    })

    it('voter can remove delegate', async () => {
      await voting.setDelegate(delegate1, {from: holder29})

      const tx = await voting.resetDelegate({from: holder29})
      assertEvent(tx, 'ResetDelegate', {
        expectedArgs: {voter: holder29, delegate: delegate1}
      })
      assertAmountOfEvents(tx, 'ResetDelegate', {expectedAmount: 1})
      const delegatedVoters = (await voting.getDelegatedVoters(delegate1, 0, 1))[0]
      assertArraysEqualAsSets(delegatedVoters, [], 'delegate1 should not be a delegate of anyone')
    })

    it('voters can remove delegate', async () => {
      await voting.setDelegate(delegate1, {from: holder20})
      await voting.setDelegate(delegate1, {from: holder29})
      await voting.setDelegate(delegate1, {from: holder51})


      const tx1 = await voting.resetDelegate({from: holder29})
      assertEvent(tx1, 'ResetDelegate', {
        expectedArgs: {voter: holder29, delegate: delegate1}
      })
      assertAmountOfEvents(tx1, 'ResetDelegate', {expectedAmount: 1})
      const tx2 = await voting.resetDelegate({from: holder51})
      assertEvent(tx2, 'ResetDelegate', {
        expectedArgs: {voter: holder51, delegate: delegate1}
      })
      assertAmountOfEvents(tx2, 'ResetDelegate', {expectedAmount: 1})
      const delegatedVoters = (await voting.getDelegatedVoters(delegate1, 0, 1))[0]
      assertArraysEqualAsSets(delegatedVoters, [holder20], 'delegate1 have only holder20 as a delegated voter')
    })

    it('voter can change delegate', async () => {
      await voting.setDelegate(delegate1, {from: holder29})
      await voting.setDelegate(delegate2, {from: holder51})

      await voting.setDelegate(delegate2, {from: holder29})

      const delegatedVotersDelegate1 = (await voting.getDelegatedVoters(delegate1, 0, 1))[0]
      assertArraysEqualAsSets(delegatedVotersDelegate1, [], 'delegate1 should not be a delegate of anyone')
      const delegatedVotersDelegate2 = (await voting.getDelegatedVoters(delegate2, 0, 2))[0]
      assertArraysEqualAsSets(delegatedVotersDelegate2, [holder29, holder51], 'delegate2 should be a delegate of holder29 and holder51')
    })

    it('delegate can manage several voters', async () => {
      await voting.setDelegate(delegate1, {from: holder29})

      const tx = await voting.setDelegate(delegate1, {from: holder51})
      assertEvent(tx, 'SetDelegate', {
        expectedArgs: {voter: holder51, delegate: delegate1}
      })
      assertAmountOfEvents(tx, 'SetDelegate', {expectedAmount: 1})

      const delegatedVoters = (await voting.getDelegatedVoters(delegate1, 0, 2))[0]
      assertArraysEqualAsSets(delegatedVoters, [holder29, holder51], 'delegate1 should be a delegate of holder29 and holder51')
    })

    // Multiple voters with non-zero balances of governance token are delegating their voting
    // power to a single delegate. The voting starts and the delegate is voting for all of them - first
    // they get the full list of voters with their balance snapshot and vote states of the given voting,
    // then they vote for that list.
    it('delegate can manage several voters and vote for them', async () => {
      await voting.setDelegate(delegate1, {from: holder1})
      await voting.setDelegate(delegate1, {from: holder20})
      await voting.setDelegate(delegate2, {from: holder29})
      await voting.setDelegate(delegate2, {from: holder51})

      await voting.unsafelyChangeVoteTime(1500)

      const voteId = createdVoteId(await voting.newVote(EMPTY_CALLS_SCRIPT, 'metadata'))

      let { snapshotBlock } = await voting.getVote(voteId)
      await new Promise( (resolve) => web3.eth.currentProvider.send(
          { method: "evm_mine", params: [], id: 42, jsonrpc: "2.0"}, resolve)
      )

      const currentBlock = await web3.eth.getBlockNumber()
      assert.isBelow(Number(snapshotBlock), currentBlock)

      // not working with getDelegatedVotersAtVote
      // await voting.mockIncreaseTime(1)
      // await voting.setDelegate(delegate2, {from: holder20})

      const delegatedVotersData1 = await voting.getDelegatedVotersAtVote(delegate1, 0, 3, voteId)
      const delegatedVotersData2 = await voting.getDelegatedVotersAtVote(delegate2, 0, 3, voteId)

      assert.equal(delegatedVotersData1[0].length, 2)
      assert.equal(delegatedVotersData2[0].length, 2)

      for (const holder of delegatedVotersData1[0]) {
        assert.equal(await voting.canVote(voteId, holder), true, 'should be able to vote')
        // await voting.vote(voteId, true, false, { from: holder })
        await voting.attemptVoteFor(voteId, false, holder, {from: delegate1})
      }

      for (const holder of delegatedVotersData2[0]) {
        assert.equal(await voting.canVote(voteId, holder), true, 'should be able to vote')
      }
      await voting.attemptVoteForMultiple(voteId, true, delegatedVotersData2[0], {from: delegate2});

      const { yea, nay } = await voting.getVote(voteId)

      assert.equal(Number(yea), bigExp(51+29, decimals))
      assert.equal(Number(nay), bigExp(20+1, decimals))

      const voterState1 = await voting.getVotersStateAtVote(voteId, delegatedVotersData1[0])
      const voterState2 = await voting.getVotersStateAtVote(voteId, delegatedVotersData2[0])

      assertArraysEqualAsSets(voterState1.map(voterState => Number(voterState)), [VOTER_STATE.DELEGATE_NAY])
      assertArraysEqualAsSets(voterState2.map(voterState => Number(voterState)), [VOTER_STATE.DELEGATE_YEA])
    })

    // Multiple voters with non-zero balances of governance token are delegating their voting
    // power to a single delegate. The voting starts and the delegate is voting for one of them.
    it('delegate can manage several voters and vote for one', async () => {
      await voting.setDelegate(delegate1, {from: holder1})
      await voting.setDelegate(delegate1, {from: holder20})
      await voting.setDelegate(delegate2, {from: holder29})
      await voting.setDelegate(delegate2, {from: holder51})

      await voting.unsafelyChangeVoteTime(1500)

      const voteId = createdVoteId(await voting.newVote(EMPTY_CALLS_SCRIPT, 'metadata'))

      let { snapshotBlock } = await voting.getVote(voteId)
      await new Promise( (resolve) => web3.eth.currentProvider.send(
          { method: "evm_mine", params: [], id: 42, jsonrpc: "2.0"}, resolve)
      )

      const currentBlock = await web3.eth.getBlockNumber()
      assert.isBelow(Number(snapshotBlock), currentBlock)

      // not working with getDelegatedVotersAtVote
      // await voting.mockIncreaseTime(1)
      // await voting.setDelegate(delegate2, {from: holder20})

      const delegatedVotersData1 = await voting.getDelegatedVotersAtVote(delegate1, 0, 3, voteId)
      const delegatedVotersData2 = await voting.getDelegatedVotersAtVote(delegate2, 0, 3, voteId)

      assert.equal(delegatedVotersData1[0].length, 2)
      assert.equal(delegatedVotersData2[0].length, 2)

      let holderD1 = delegatedVotersData1[0][1]
      assert.equal(await voting.canVote(voteId, holderD1), true, 'should be able to vote')
      // await voting.vote(voteId, true, false, { from: holderD1 })
      await voting.attemptVoteFor(voteId, false, holderD1, {from: delegate1})

      const holderD2 = delegatedVotersData2[0][1]
      assert.equal(await voting.canVote(voteId, holderD2), true, 'should be able to vote')

      await voting.attemptVoteForMultiple(voteId, true, [holderD2], {from: delegate2});

      const { yea, nay } = await voting.getVote(voteId)

      assert.equal(Number(yea), bigExp(51, decimals))
      assert.equal(Number(nay), bigExp(20, decimals))

      const voterState1 = await voting.getVotersStateAtVote(voteId, [holderD1])
      const voterState2 = await voting.getVotersStateAtVote(voteId, [holderD2])

      assertArraysEqualAsSets(voterState1.map(voterState => Number(voterState)), [VOTER_STATE.DELEGATE_NAY])
      assertArraysEqualAsSets(voterState2.map(voterState => Number(voterState)), [VOTER_STATE.DELEGATE_YEA])
    })

    // A delegated voter can overwrite a delegate's vote.
    it('delegate can manage several voters and vote for one', async () => {
      await voting.setDelegate(delegate1, {from: holder1})
      await voting.setDelegate(delegate1, {from: holder20})
      await voting.setDelegate(delegate2, {from: holder29})
      await voting.setDelegate(delegate2, {from: holder51})

      await voting.unsafelyChangeVoteTime(1500)

      const voteId = createdVoteId(await voting.newVote(EMPTY_CALLS_SCRIPT, 'metadata'))

      let { snapshotBlock } = await voting.getVote(voteId)
      await new Promise( (resolve) => web3.eth.currentProvider.send(
          { method: "evm_mine", params: [], id: 42, jsonrpc: "2.0"}, resolve)
      )

      const currentBlock = await web3.eth.getBlockNumber()
      assert.isBelow(Number(snapshotBlock), currentBlock)

      // not working with getDelegatedVotersAtVote
      // await voting.mockIncreaseTime(1)
      // await voting.setDelegate(delegate2, {from: holder20})

      const delegatedVotersData1 = await voting.getDelegatedVotersAtVote(delegate1, 0, 3, voteId)
      const delegatedVotersData2 = await voting.getDelegatedVotersAtVote(delegate2, 0, 3, voteId)

      assert.equal(delegatedVotersData1[0].length, 2)
      assert.equal(delegatedVotersData2[0].length, 2)

      let holderD1 = delegatedVotersData1[0][1]
      assert.equal(await voting.canVote(voteId, holderD1), true, 'should be able to vote')
      // await voting.vote(voteId, true, false, { from: holderD1 })
      await voting.attemptVoteFor(voteId, false, holderD1, {from: delegate1})

      await voting.vote(voteId, true, false, {from: holderD1})

      const holderD2 = delegatedVotersData2[0][1]
      assert.equal(await voting.canVote(voteId, holderD2), true, 'should be able to vote')

      await voting.attemptVoteForMultiple(voteId, true, [holderD2], {from: delegate2});
      await voting.vote(voteId, false, false, {from: holderD2})

      const { yea, nay } = await voting.getVote(voteId)

      assert.equal(Number(yea), bigExp(20, decimals))
      assert.equal(Number(nay), bigExp(51, decimals))

      const voterState1 = await voting.getVotersStateAtVote(voteId, [holderD1])
      const voterState2 = await voting.getVotersStateAtVote(voteId, [holderD2])

      assertArraysEqualAsSets(voterState1.map(voterState => Number(voterState)), [VOTER_STATE.YEA])
      assertArraysEqualAsSets(voterState2.map(voterState => Number(voterState)), [VOTER_STATE.NAY])
    })
  })

  context('delegation state management', () => {
    const neededSupport = pct16(50)
    const minimumAcceptanceQuorum = pct16(20)
    const decimals = 18
    const defaultLimit = 100

    beforeEach(async () => {
      token = await MiniMeToken.new(ZERO_ADDRESS, ZERO_ADDRESS, 0, 'n', decimals, 'n', true) // empty parameters minime

      await token.generateTokens(holder20, bigExp(20, decimals))
      await token.generateTokens(holder29, bigExp(29, decimals))
      await token.generateTokens(holder51, bigExp(51, decimals))
      await voting.initialize(token.address, neededSupport, minimumAcceptanceQuorum, votingDuration, 0)

      executionTarget = await ExecutionTarget.new()
    })

    it(`voter can assign themself a delegate`, async () => {
      const tx = await voting.setDelegate(delegate1, {from: holder29})
      assertEvent(tx, 'SetDelegate', {
        expectedArgs: {voter: holder29, delegate: delegate1}
      })
      assertAmountOfEvents(tx, 'SetDelegate', {expectedAmount: 1})

      const delegate = await voting.getDelegate(holder29)
      assert.equal(delegate, delegate1, 'holder29 should have delegate1 as a delegate')

      const delegatedVoters = (await voting.getDelegatedVoters(delegate1, 0, defaultLimit))[0]
      assertArraysEqualAsSets(delegatedVoters, [holder29], 'delegate1 should be a delegate of holder29')
    })

    it(`voter can change their assigned delegate`, async () => {
      await voting.setDelegate(delegate1, {from: holder29})

      const tx = await voting.setDelegate(delegate2, {from: holder29})
      assertEvent(tx, 'SetDelegate', {
        expectedArgs: {voter: holder29, delegate: delegate2}
      })
      assertAmountOfEvents(tx, 'SetDelegate', {expectedAmount: 1})

      const delegate = await voting.getDelegate(holder29)
      assert.equal(delegate, delegate2, 'holder29 should have delegate2 as a delegate')

      const delegatedVoters = (await voting.getDelegatedVoters(delegate2, 0, defaultLimit))[0]
      assertArraysEqualAsSets(delegatedVoters, [holder29], 'delegate2 should be a delegate of holder29')
    })

    it(`multiple voters can assign themselves the delegate`, async () => {
      await voting.setDelegate(delegate1, {from: holder29})
      await voting.setDelegate(delegate1, {from: holder20})

      const delegate29 = await voting.getDelegate(holder29)
      assert.equal(delegate29, delegate1, 'holder29 should have delegate1 as a delegate')

      const delegate20 = await voting.getDelegate(holder20)
      assert.equal(delegate20, delegate1, 'holder20 should have delegate1 as a delegate')


      const delegatedVoters = (await voting.getDelegatedVoters(delegate1, 0, defaultLimit))[0]
      assertArraysEqualAsSets(delegatedVoters, [holder29, holder20], 'delegate1 should be a delegate of both holder29 and holder20')
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

    it(`voter with zero token balance can't assign a delegate `, async () => {
      await assertRevert(
        voting.setDelegate(delegate1, {from: nonHolder}),
        ERRORS.VOTING_NO_VOTING_POWER
      )
    })

    it(`voter can unassign their delegate`, async () => {
      await voting.setDelegate(delegate1, {from: holder29})

      const tx = await voting.resetDelegate({from: holder29})
      assertEvent(tx, 'ResetDelegate', {
        expectedArgs: {voter: holder29, delegate: delegate1}
      })
      assertAmountOfEvents(tx, 'ResetDelegate', {expectedAmount: 1})

      const delegate = await voting.getDelegate(holder29)
      assert.equal(delegate, ZERO_ADDRESS, `holder29 shouldn't have a delegate anymore`)

      const delegatedVoters = (await voting.getDelegatedVoters(delegate2, 0, defaultLimit))[0]
      assertArraysEqualAsSets(delegatedVoters, [], 'delegatedVoters should be empty')
    })

    it(`voter can't unassign their delegate if they wasn't assigned before`, async () => {
      await assertRevert(
        voting.resetDelegate({from: holder29}),
        ERRORS.VOTING_DELEGATE_NOT_SET
      )
    })

    it(`voter can unassign a delegate who has multiple delegated voters`, async () => {
      await voting.setDelegate(delegate1, {from: holder20})
      await voting.setDelegate(delegate1, {from: holder29})

      await voting.resetDelegate({from: holder29})
      const delegate = await voting.getDelegate(holder29)
      assert.equal(delegate, ZERO_ADDRESS, `holder29 shouldn't have a delegate anymore`)

      const delegatedVoters = (await voting.getDelegatedVoters(delegate1, 0, defaultLimit))[0]
      assertArraysEqualAsSets(delegatedVoters, [holder20], 'delegatedVoters should contain only holder20')
    })

    it(`multiple voters can unassign the delegate`, async () => {
      await voting.setDelegate(delegate1, {from: holder20})
      await voting.setDelegate(delegate1, {from: holder29})
      await voting.setDelegate(delegate1, {from: holder51})

      await voting.resetDelegate({from: holder29})
      await voting.resetDelegate({from: holder51})

      const delegate20 = await voting.getDelegate(holder20)
      assert.equal(delegate20, delegate1, `holder20 should still have delegate1 as a delegate`)

      const delegate29 = await voting.getDelegate(holder29)
      assert.equal(delegate29, ZERO_ADDRESS, `holder29 shouldn't have a delegate anymore`)

      const delegate51 = await voting.getDelegate(holder51)
      assert.equal(delegate51, ZERO_ADDRESS, `holder51 shouldn't have a delegate anymore`)

      const delegatedVoters = (await voting.getDelegatedVoters(delegate1, 0, defaultLimit))[0]
      assertArraysEqualAsSets(delegatedVoters, [holder20], 'delegatedVoters should contain only holder20')
    })

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
})
