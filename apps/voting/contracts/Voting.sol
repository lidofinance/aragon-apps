/*
 * SPDX-License-Identitifer:    GPL-3.0-or-later
 */

pragma solidity 0.4.24;

import "@aragon/os/contracts/apps/AragonApp.sol";
import "@aragon/os/contracts/common/IForwarder.sol";

import "@aragon/os/contracts/lib/math/SafeMath.sol";
import "@aragon/os/contracts/lib/math/SafeMath64.sol";

import "@aragon/minime/contracts/MiniMeToken.sol";


contract Voting is IForwarder, AragonApp {
    using SafeMath for uint256;
    using SafeMath64 for uint64;

    bytes32 public constant CREATE_VOTES_ROLE = keccak256("CREATE_VOTES_ROLE");
    bytes32 public constant MODIFY_SUPPORT_ROLE = keccak256("MODIFY_SUPPORT_ROLE");
    bytes32 public constant MODIFY_QUORUM_ROLE = keccak256("MODIFY_QUORUM_ROLE");
    bytes32 public constant UNSAFELY_MODIFY_VOTE_TIME_ROLE = keccak256("UNSAFELY_MODIFY_VOTE_TIME_ROLE");

    uint64 public constant PCT_BASE = 10 ** 18; // 0% = 0; 1% = 10^16; 100% = 10^18

    uint256 private constant UINT_96_MAX = 0xFFFFFFFFFFFFFFFFFFFFFFFF;
    string private constant ERROR_NO_VOTE = "VOTING_NO_VOTE";
    string private constant ERROR_INIT_PCTS = "VOTING_INIT_PCTS";
    string private constant ERROR_CHANGE_SUPPORT_PCTS = "VOTING_CHANGE_SUPPORT_PCTS";
    string private constant ERROR_CHANGE_QUORUM_PCTS = "VOTING_CHANGE_QUORUM_PCTS";
    string private constant ERROR_INIT_SUPPORT_TOO_BIG = "VOTING_INIT_SUPPORT_TOO_BIG";
    string private constant ERROR_CHANGE_SUPPORT_TOO_BIG = "VOTING_CHANGE_SUPP_TOO_BIG";
    string private constant ERROR_CAN_NOT_VOTE = "VOTING_CAN_NOT_VOTE";
    string private constant ERROR_CAN_NOT_EXECUTE = "VOTING_CAN_NOT_EXECUTE";
    string private constant ERROR_CAN_NOT_FORWARD = "VOTING_CAN_NOT_FORWARD";
    string private constant ERROR_NO_VOTING_POWER = "VOTING_NO_VOTING_POWER";
    string private constant ERROR_CHANGE_VOTE_TIME = "VOTING_VOTE_TIME_TOO_SMALL";
    string private constant ERROR_CHANGE_OBJECTION_TIME = "VOTING_OBJ_TIME_TOO_BIG";
    string private constant ERROR_INIT_OBJ_TIME_TOO_BIG = "VOTING_INIT_OBJ_TIME_TOO_BIG";
    string private constant ERROR_CAN_NOT_VOTE_FOR = "VOTING_CAN_NOT_VOTE_FOR";
    string private constant ERROR_ZERO_ADDRESS_PASSED = "VOTING_ZERO_ADDRESS_PASSED";
    string private constant ERROR_DELEGATE_NOT_SET = "VOTING_DELEGATE_NOT_SET";
    string private constant ERROR_SELF_DELEGATE = "VOTING_SELF_DELEGATE";
    string private constant ERROR_DELEGATE_SAME_AS_PREV = "VOTING_DELEGATE_SAME_AS_PREV";
    string private constant ERROR_INVALID_LIMIT = "VOTING_INVALID_LIMIT";
    string private constant ERROR_INVALID_OFFSET = "VOTING_INVALID_OFFSET";
    string private constant ERROR_MAX_DELEGATED_VOTERS_REACHED = "VOTING_MAX_DELEGATED_VOTERS_REACHED";

    enum VoterState { Absent, Yea, Nay, DelegateYea, DelegateNay }

    enum VotePhase { Main, Objection, Closed }

    struct Vote {
        bool executed;
        uint64 startDate;
        uint64 snapshotBlock;
        uint64 supportRequiredPct;
        uint64 minAcceptQuorumPct;
        uint256 yea;
        uint256 nay;
        uint256 votingPower;
        bytes executionScript;
        mapping (address => VoterState) voters;
    }

    struct DelegatedAddressList {
        address[] addresses;
    }

    struct Delegate {
        address delegate;
        uint96 voterIndex;
    }

    MiniMeToken public token;
    uint64 public supportRequiredPct;
    uint64 public minAcceptQuorumPct;
    uint64 public voteTime;

    // We are mimicing an array, we use a mapping instead to make app upgrade more graceful
    mapping (uint256 => Vote) internal votes;
    uint256 public votesLength;
    uint64 public objectionPhaseTime;

    // delegate -> [delegated voter address]
    mapping(address => DelegatedAddressList) private delegatedVoters;
    // voter -> delegate
    mapping(address => Delegate) private delegates;

    event StartVote(uint256 indexed voteId, address indexed creator, string metadata);
    event CastVote(uint256 indexed voteId, address indexed voter, bool supports, uint256 stake);
    event CastObjection(uint256 indexed voteId, address indexed voter, uint256 stake);
    event ExecuteVote(uint256 indexed voteId);
    event ChangeSupportRequired(uint64 supportRequiredPct);
    event ChangeMinQuorum(uint64 minAcceptQuorumPct);
    event ChangeVoteTime(uint64 voteTime);
    event ChangeObjectionPhaseTime(uint64 objectionPhaseTime);
    event SetDelegate(address indexed voter, address indexed delegate);
    event RemoveDelegate(address indexed voter, address indexed delegate);
    event CastVoteAsDelegate(uint256 indexed voteId, address indexed delegate, address indexed voter, bool supports, uint256 stake);

    modifier voteExists(uint256 _voteId) {
        require(_voteId < votesLength, ERROR_NO_VOTE);
        _;
    }

    /**
    * @notice Initialize Voting app with `_token.symbol(): string` for governance, minimum support of `@formatPct(_supportRequiredPct)`%, minimum acceptance quorum of `@formatPct(_minAcceptQuorumPct)`%, and a voting duration of `@transformTime(_voteTime)`
    * @param _token MiniMeToken Address that will be used as governance token
    * @param _supportRequiredPct Percentage of yeas in casted votes for a vote to succeed (expressed as a percentage of 10^18; eg. 10^16 = 1%, 10^18 = 100%)
    * @param _minAcceptQuorumPct Percentage of yeas in total possible votes for a vote to succeed (expressed as a percentage of 10^18; eg. 10^16 = 1%, 10^18 = 100%)
    * @param _voteTime Total duration of voting in seconds.
    * @param _objectionPhaseTime The duration of the objection vote phase, i.e. seconds that a vote will be open after the main vote phase ends for token holders to object to the outcome. Main phase duration is calculated as `voteTime - objectionPhaseTime`.
    */
    function initialize(MiniMeToken _token, uint64 _supportRequiredPct, uint64 _minAcceptQuorumPct, uint64 _voteTime, uint64 _objectionPhaseTime)
        external
        onlyInit
    {
        initialized();

        require(_minAcceptQuorumPct <= _supportRequiredPct, ERROR_INIT_PCTS);
        require(_supportRequiredPct < PCT_BASE, ERROR_INIT_SUPPORT_TOO_BIG);
        require(_voteTime > _objectionPhaseTime, ERROR_INIT_OBJ_TIME_TOO_BIG);

        token = _token;
        supportRequiredPct = _supportRequiredPct;
        minAcceptQuorumPct = _minAcceptQuorumPct;
        voteTime = _voteTime;
        objectionPhaseTime = _objectionPhaseTime;
    }

    /**
    * @notice Change required support to `@formatPct(_supportRequiredPct)`%
    * @param _supportRequiredPct New required support
    */
    function changeSupportRequiredPct(uint64 _supportRequiredPct)
        external
        authP(MODIFY_SUPPORT_ROLE, arr(uint256(_supportRequiredPct), uint256(supportRequiredPct)))
    {
        require(minAcceptQuorumPct <= _supportRequiredPct, ERROR_CHANGE_SUPPORT_PCTS);
        require(_supportRequiredPct < PCT_BASE, ERROR_CHANGE_SUPPORT_TOO_BIG);
        supportRequiredPct = _supportRequiredPct;

        emit ChangeSupportRequired(_supportRequiredPct);
    }

    /**
    * @notice Change minimum acceptance quorum to `@formatPct(_minAcceptQuorumPct)`%
    * @param _minAcceptQuorumPct New acceptance quorum
    */
    function changeMinAcceptQuorumPct(uint64 _minAcceptQuorumPct)
        external
        authP(MODIFY_QUORUM_ROLE, arr(uint256(_minAcceptQuorumPct), uint256(minAcceptQuorumPct)))
    {
        require(_minAcceptQuorumPct <= supportRequiredPct, ERROR_CHANGE_QUORUM_PCTS);
        minAcceptQuorumPct = _minAcceptQuorumPct;

        emit ChangeMinQuorum(_minAcceptQuorumPct);
    }

    /**
    * @notice Change vote time to `_voteTime` sec. The change affects all existing unexecuted votes, so be really careful with it
    * @param _voteTime New vote time
    */
    function unsafelyChangeVoteTime(uint64 _voteTime)
        external
        auth(UNSAFELY_MODIFY_VOTE_TIME_ROLE)
    {
        require(_voteTime > objectionPhaseTime, ERROR_CHANGE_VOTE_TIME);
        voteTime = _voteTime;

        emit ChangeVoteTime(_voteTime);
    }

    /**
    * @notice Change the objection phase duration to `_objectionPhaseTime` sec. The change affects all existing unexecuted votes, so be really careful with it
    * @param _objectionPhaseTime New objection time
    */
    function unsafelyChangeObjectionPhaseTime(uint64 _objectionPhaseTime)
        external
        auth(UNSAFELY_MODIFY_VOTE_TIME_ROLE)
    {
        require(voteTime > _objectionPhaseTime, ERROR_CHANGE_OBJECTION_TIME);
        objectionPhaseTime = _objectionPhaseTime;

        emit ChangeObjectionPhaseTime(_objectionPhaseTime);
    }

    /**
    * @notice Create a new vote about "`_metadata`"
    * @param _executionScript EVM script to be executed on approval
    * @param _metadata Vote metadata
    * @return voteId Id for newly created vote
    */
    function newVote(bytes _executionScript, string _metadata) external auth(CREATE_VOTES_ROLE) returns (uint256 voteId) {
        return _newVote(_executionScript, _metadata);
    }

    /**
    * @notice Create a new vote about "`_metadata`"
    * @dev  _executesIfDecided was deprecated to introduce a proper lock period between decision and execution.
    * @param _executionScript EVM script to be executed on approval
    * @param _metadata Vote metadata
    * @param _castVote_deprecated Whether to also cast newly created vote
    * @param _executesIfDecided_deprecated Whether to also immediately execute newly created vote if decided
    * @return voteId id for newly created vote
    */
    function newVote(bytes _executionScript, string _metadata, bool _castVote_deprecated, bool _executesIfDecided_deprecated)
        external
        auth(CREATE_VOTES_ROLE)
        returns (uint256 voteId)
    {
        return _newVote(_executionScript, _metadata);
    }

    /**
    * @notice Vote `_supports ? 'yes' : 'no'` in vote #`_voteId`. During objection phase one can only vote 'no'
    * @dev Initialization check is implicitly provided by `voteExists()` as new votes can only be
    *      created via `newVote(),` which requires initialization
    * @dev  _executesIfDecided was deprecated to introduce a proper lock period between decision and execution.
    * @param _voteId Id for vote
    * @param _supports Whether voter supports the vote
    * @param _executesIfDecided_deprecated Whether the vote should execute its action if it becomes decided
    */
    function vote(uint256 _voteId, bool _supports, bool _executesIfDecided_deprecated) external voteExists(_voteId) {
        require(_canParticipateInVote(_voteId, _supports), ERROR_CAN_NOT_VOTE);
        require(_hasVotingPower(votes[_voteId], msg.sender), ERROR_NO_VOTING_POWER);
        _vote(_voteId, _supports, msg.sender, false);
    }

    /**
    * @notice Execute vote #`_voteId`
    * @dev Initialization check is implicitly provided by `voteExists()` as new votes can only be
    *      created via `newVote(),` which requires initialization
    * @param _voteId Id for vote
    */
    function executeVote(uint256 _voteId) external voteExists(_voteId) {
        _executeVote(_voteId);
    }

    /**
    * @notice Assign `_delegate` as the delegate for the sender
    * @param _delegate address to delegate to
    */
    function setDelegate(address _delegate) public {
        require(_delegate != address(0), ERROR_ZERO_ADDRESS_PASSED);

        address msgSender = msg.sender;
        require(_delegate != msgSender, ERROR_SELF_DELEGATE);

        address prevDelegate = delegates[msgSender].delegate;
        require(_delegate != prevDelegate, ERROR_DELEGATE_SAME_AS_PREV);

        uint256 votingPower = token.balanceOfAt(msgSender, getBlockNumber64() - 1);
        require(votingPower > 0, ERROR_NO_VOTING_POWER);

        if (prevDelegate != address(0)) {
            _removeDelegatedAddressFor(prevDelegate, msgSender);
        }
        _addDelegatedAddressFor(_delegate, msgSender);

        emit SetDelegate(msgSender, _delegate);
    }

    function removeDelegate() public {
        address msgSender = msg.sender;
        address prevDelegate = delegates[msgSender].delegate;
        require(prevDelegate != address(0), ERROR_DELEGATE_NOT_SET);

        _removeDelegatedAddressFor(prevDelegate, msgSender);
        delete delegates[msgSender];

        emit RemoveDelegate(msgSender, prevDelegate);
    }

    /**
     * @notice Vote `_supports ? 'yes' : 'no'` in vote #`_voteId` on behalf of the `_voters` list
     * @param _voteId Id for vote
     * @param _supports Whether the delegate supports the vote
     * @param _voters list of voters
     */
    function voteForMultiple(uint256 _voteId, bool _supports, address[] _voters) public voteExists(_voteId) {
        require(_canParticipateInVote(_voteId, _supports), ERROR_CAN_NOT_VOTE);

        Vote storage vote_ = votes[_voteId];
        address msgSender = msg.sender;
        bool hasManagedToVote = false;

        for (uint256 i = 0; i < _voters.length; ++i) {
            address voter = _voters[i];
            require(_hasVotingPower(vote_, voter), ERROR_NO_VOTING_POWER);
            if (_canVoteFor(vote_, msgSender, voter)) {
                _vote(_voteId, _supports, voter, true);
                hasManagedToVote = true;
            }
        }

        require(hasManagedToVote, ERROR_CAN_NOT_VOTE_FOR);
    }

    /**
     * @notice Vote `_supports ? 'yes' : 'no'` in vote #`_voteId` on behalf of the `_voter`
     * @param _voteId Id for vote
     * @param _supports Whether the delegate supports the vote
     * @param _voter address of the voter
     */
    function voteFor(uint256 _voteId, bool _supports, address _voter) external voteExists(_voteId) {
        address[] memory voters = new address[](1);
        voters[0] = _voter;
        voteForMultiple(_voteId, _supports, voters);
    }

    // Forwarding fns

    /**
    * @notice Tells whether the Voting app is a forwarder or not
    * @dev IForwarder interface conformance
    * @return Always true
    */
    function isForwarder() external pure returns (bool) {
        return true;
    }

    /**
    * @notice Creates a vote to execute the desired action
    * @dev IForwarder interface conformance
    * @param _evmScript Start vote with script
    */
    function forward(bytes _evmScript) public {
        require(canForward(msg.sender, _evmScript), ERROR_CAN_NOT_FORWARD);
        _newVote(_evmScript, "");
    }

    /**
    * @notice Tells whether `_sender` can forward actions or not
    * @dev IForwarder interface conformance
    * @param _sender Address of the account intending to forward an action
    * @return True if the given address can create votes, false otherwise
    */
    function canForward(address _sender, bytes) public view returns (bool) {
        // Note that `canPerform()` implicitly does an initialization check itself
        return canPerform(_sender, CREATE_VOTES_ROLE, arr());
    }

    // Getter fns

    /**
    * @notice Tells whether a vote #`_voteId` can be executed or not
    * @dev Initialization check is implicitly provided by `voteExists()` as new votes can only be
    *      created via `newVote(),` which requires initialization
    * @param _voteId Vote identifier
    * @return True if the given vote can be executed, false otherwise
    */
    function canExecute(uint256 _voteId) public view voteExists(_voteId) returns (bool) {
        return _canExecute(_voteId);
    }

    /**
    * @notice Tells whether `_voter` can participate in the main or objection phase of the vote #`_voteId`
    * @dev Initialization check is implicitly provided by `voteExists()` as new votes can only be
    *      created via `newVote(),` which requires initialization
    * @param _voteId Vote identifier
    * @param _voter address of the voter to check
    * @return True if the given voter can participate in the main phase of a certain vote, false otherwise
    */
    function canVote(uint256 _voteId, address _voter) external view voteExists(_voteId) returns (bool) {
        Vote storage vote_ = votes[_voteId];
        return _canParticipateInVote(_voteId, false) && _hasVotingPower(vote_, _voter);
    }

    /**
    * @notice Tells the current phase of the vote #`_voteId`
    * @dev Initialization check is implicitly provided by `voteExists()` as new votes can only be
    *      created via `newVote(),` which requires initialization
    * @param _voteId Vote identifier
    * @return VotePhase.Main if one can vote yes or no and VotePhase.Objection if one can vote only no and VotingPhase.Closed if no votes are accepted
    */
    function getVotePhase(uint256 _voteId) external view voteExists(_voteId) returns (VotePhase) {
        return _getVotePhase(votes[_voteId]);
    }

    /**
    * @dev Return all information for a vote by its ID
    * @param _voteId Vote identifier
    * @return true if the vote is open
    * @return Vote executed status
    * @return Vote start date
    * @return Vote snapshot block
    * @return Vote support required
    * @return Vote minimum acceptance quorum
    * @return Vote yeas amount
    * @return Vote nays amount
    * @return Vote power
    * @return Vote script
    * @return Vote phase
    */
    function getVote(uint256 _voteId)
        public
        view
        voteExists(_voteId)
        returns (
            bool open,
            bool executed,
            uint64 startDate,
            uint64 snapshotBlock,
            uint64 supportRequired,
            uint64 minAcceptQuorum,
            uint256 yea,
            uint256 nay,
            uint256 votingPower,
            bytes script,
            VotePhase phase
        )
    {
        Vote storage vote_ = votes[_voteId];

        open = _isVoteOpen(vote_);
        executed = vote_.executed;
        startDate = vote_.startDate;
        snapshotBlock = vote_.snapshotBlock;
        supportRequired = vote_.supportRequiredPct;
        minAcceptQuorum = vote_.minAcceptQuorumPct;
        yea = vote_.yea;
        nay = vote_.nay;
        votingPower = vote_.votingPower;
        script = vote_.executionScript;
        phase = _getVotePhase(vote_);
    }

    /**
    * @dev Return the state of a voter for a given vote by its ID
    * @param _voteId Vote identifier
    * @param _voter address of the voter
    * @return VoterState of the requested voter for a certain vote
    */
    function getVoterState(uint256 _voteId, address _voter) public view voteExists(_voteId) returns (VoterState) {
        return votes[_voteId].voters[_voter];
    }

    /**
     * @notice Return the sliced list of delegated voters for `_delegate` and their voting power at the current block
     * @param _delegate the address of the delegate
     * @param _offset the number of delegated voters from the start of the list to skip
     * @param _limit the number of delegated voters to return
     * @return the array of delegated voters
     * @return the array of voting power of delegated voters
     */
    function getDelegatedVoters(address _delegate, uint256 _offset, uint256 _limit) public view returns (address[] memory, uint256[] memory) {
        return _getDelegatedVotersAt(_delegate, _offset, _limit, getBlockNumber64());
    }

    /**
     * @notice Return the sliced list of delegated voters for `_delegate` and their voting power at the `_voteId` snapshot block
     * @param _delegate the address of the delegate
     * @param _offset the number of delegated voters from the start of the list to skip
     * @param _limit the number of delegated voters to return
     * @return the array of delegated voters
     * @return the array of voting power of delegated voters
     */
    function getDelegatedVotersAtVote(address _delegate, uint256 _offset, uint256 _limit, uint256 _voteId) public view voteExists(_voteId) returns (address[] memory, uint256[] memory) {
        Vote storage vote_ = votes[_voteId];
        return _getDelegatedVotersAt(_delegate, _offset, _limit, vote_.snapshotBlock);
    }

    /**
    * @dev Return the number of delegated voters for the `_delegate`
    * @param _delegate address of the delegate
    * @return the number of delegated voters
    */
    function getDelegatedVotersCount(address _delegate) public view returns (uint256) {
        require(_delegate != address(0), ERROR_ZERO_ADDRESS_PASSED);
        return delegatedVoters[_delegate].addresses.length;
    }

    /**
     * @notice Return the delegate address assigned to the `_voter`
     * @param _voter the address of the voter
     */
    function getDelegate(address _voter) public view returns (address) {
        require(_voter != address(0), ERROR_ZERO_ADDRESS_PASSED);
        return delegates[_voter].delegate;
    }

    /**
     * @notice Return the list of `VoterState` for the `_voters` for the vote #`_voteId`
     * @param _voters the list of voters
     * @param _voteId Vote identifier
     */
    function getVotersStateAtVote(address[] _voters, uint256 _voteId) public view voteExists(_voteId) returns (VoterState[] memory voterStatesList) {
        uint256 length = _voters.length;
        voterStatesList = new VoterState[](length);
        Vote storage vote_ = votes[_voteId];
        for (uint256 i = 0; i < length; ++i) {
            voterStatesList[i] = vote_.voters[_voters[i]];
        }
        return voterStatesList;
    }

    // Internal fns

    /**
    * @dev Internal function to create a new vote
    * @return voteId id for newly created vote
    */
    function _newVote(bytes _executionScript, string _metadata) internal returns (uint256 voteId) {
        uint64 snapshotBlock = getBlockNumber64() - 1; // avoid double voting in this very block
        uint256 votingPower = token.totalSupplyAt(snapshotBlock);
        require(votingPower > 0, ERROR_NO_VOTING_POWER);

        voteId = votesLength++;

        Vote storage vote_ = votes[voteId];
        vote_.startDate = getTimestamp64();
        vote_.snapshotBlock = snapshotBlock;
        vote_.supportRequiredPct = supportRequiredPct;
        vote_.minAcceptQuorumPct = minAcceptQuorumPct;
        vote_.votingPower = votingPower;
        vote_.executionScript = _executionScript;

        emit StartVote(voteId, msg.sender, _metadata);
    }

    /**
    * @dev Internal function to cast a vote or object to.
      @dev It assumes that voter can support or object to the vote
    */
    function _vote(uint256 _voteId, bool _supports, address _voter, bool _isDelegate) internal {
        Vote storage vote_ = votes[_voteId];

        // This could re-enter, though we can assume the governance token is not malicious
        uint256 voterStake = token.balanceOfAt(_voter, vote_.snapshotBlock);
        VoterState state = vote_.voters[_voter];

        // If voter had previously voted, decrease count
        if (state == VoterState.Yea || state == VoterState.DelegateYea) {
            vote_.yea = vote_.yea.sub(voterStake);
        } else if (state == VoterState.Nay || state == VoterState.DelegateNay) {
            vote_.nay = vote_.nay.sub(voterStake);
        }

        if (_supports) {
            vote_.yea = vote_.yea.add(voterStake);
            vote_.voters[_voter] = _isDelegate ? VoterState.DelegateYea : VoterState.Yea;
        } else {
            vote_.nay = vote_.nay.add(voterStake);
            vote_.voters[_voter] = _isDelegate ? VoterState.DelegateNay : VoterState.Nay;
        }

        emit CastVote(_voteId, _voter, _supports, voterStake);

        if (_getVotePhase(vote_) == VotePhase.Objection) {
            emit CastObjection(_voteId, _voter, voterStake);
        }

        if (_isDelegate) {
            emit CastVoteAsDelegate(_voteId, msg.sender, _voter, _supports, voterStake);
        }
    }

    /**
    * @dev Internal function to execute a vote. It assumes the queried vote exists.
    */
    function _executeVote(uint256 _voteId) internal {
        require(_canExecute(_voteId), ERROR_CAN_NOT_EXECUTE);
        _unsafeExecuteVote(_voteId);
    }

    /**
    * @dev Unsafe version of _executeVote that assumes you have already checked if the vote can be executed and exists
    */
    function _unsafeExecuteVote(uint256 _voteId) internal {
        Vote storage vote_ = votes[_voteId];

        vote_.executed = true;

        bytes memory input = new bytes(0); // TODO: Consider input for voting scripts
        runScript(vote_.executionScript, input, new address[](0));

        emit ExecuteVote(_voteId);
    }

    /**
     * @dev internal function to add the `_voter` to the list of delegated voters for the `_delegate` and update the delegate for the `_voter`
     * @param _delegate address of the delegate
     * @param _voter address of the voter
     */
    function _addDelegatedAddressFor(address _delegate, address _voter) internal {
        uint256 length = delegatedVoters[_delegate].addresses.length;
        require(length < UINT_96_MAX, ERROR_MAX_DELEGATED_VOTERS_REACHED);

        delegatedVoters[_delegate].addresses.push(_voter);
        delegates[_voter] = Delegate(_delegate, uint96(delegatedVoters[_delegate].addresses.length.sub(1)));
    }

    /**
     * @dev internal function to remove  the `_voter` from the list of delegated voters for the `_delegate`
     * @param _delegate address of the delegate
     * @param _voter address of the voter
     */
    function _removeDelegatedAddressFor(address _delegate, address _voter) internal {
        uint256 length = delegatedVoters[_delegate].addresses.length;
        require(length > 0, ERROR_DELEGATE_NOT_SET);

        uint96 voterIndex = delegates[_voter].voterIndex;
        address lastVoter = delegatedVoters[_delegate].addresses[length - 1];
        if (voterIndex < length - 1) {
            delegatedVoters[_delegate].addresses[voterIndex] = lastVoter;
            delegates[lastVoter].voterIndex = voterIndex;
        }
        delegatedVoters[_delegate].addresses.length--;
    }

    /**
     * @notice Return the sliced list of delegated voters for `_delegate` and their voting power at the `_blockNumber`
     * @param _delegate the address of the delegate
     * @param _offset the number of delegated voters from the start of the list to skip
     * @param _limit the number of delegated voters to return
     * @return the array of delegated voters
     * @return the array of voting power of delegated voters
     */
    function _getDelegatedVotersAt(address _delegate, uint256 _offset, uint256 _limit, uint256 _blockNumber) internal view returns (address[] memory votersList, uint256[] memory votingPowerList) {
        require(_delegate != address(0), ERROR_ZERO_ADDRESS_PASSED);
        require(_limit > 0, ERROR_INVALID_LIMIT);
        uint256 length = delegatedVoters[_delegate].addresses.length;
        if (length == 0) {
            return (new address[](0), new uint256[](0));
        }
        require(_offset < length, ERROR_INVALID_OFFSET);

        uint256 returnCount = _offset.add(_limit) > length ? length.sub(_offset) : _limit;
        votersList = new address[](returnCount);
        votingPowerList = new uint256[](returnCount);
        for (uint256 i = 0; i < returnCount; ++i) {
            address voter = delegatedVoters[_delegate].addresses[_offset + i];
            votersList[i] = voter;
            votingPowerList[i] = token.balanceOfAt(voter, _blockNumber);
        }
        return (votersList, votingPowerList);
    }

    /**
    * @dev Internal function to check if a vote can be executed. It assumes the queried vote exists.
    * @return True if the given vote can be executed, false otherwise
    */
    function _canExecute(uint256 _voteId) internal view returns (bool) {
        Vote storage vote_ = votes[_voteId];

        if (vote_.executed) {
            return false;
        }

        // Vote ended?
        if (_isVoteOpen(vote_)) {
            return false;
        }

        // Has enough support?
        uint256 voteYea = vote_.yea;
        uint256 totalVotes = voteYea.add(vote_.nay);
        if (!_isValuePct(voteYea, totalVotes, vote_.supportRequiredPct)) {
            return false;
        }
        // Has min quorum?
        if (!_isValuePct(voteYea, vote_.votingPower, vote_.minAcceptQuorumPct)) {
            return false;
        }

        return true;
    }

    /**
    * @dev Internal function to check if a voter can participate on a vote. It assumes the queried vote exists.
    * @return True if the given voter can participate a certain vote, false otherwise
    */
    function _canParticipateInVote(uint256 _voteId, bool _supports) internal view returns (bool) {
        Vote storage vote_ = votes[_voteId];
        return _isVoteOpen(vote_) && _isValidPhaseToVote(vote_, _supports);
    }

    function _isDelegateFor(address _delegate, address _voter) internal view returns (bool) {
        if (_delegate == address(0) || _voter == address(0)) {
            return false;
        }
        return delegates[_voter].delegate == _delegate;
    }

    function _canVoteFor(Vote storage _vote, address _delegate, address _voter) internal view returns (bool) {
        return _isDelegateFor(_delegate, _voter) && !_hasVoted(_vote, _voter);
    }

    function _isValidPhaseToVote(Vote storage _vote, bool _supports) internal view returns (bool) {
        return !_supports || _getVotePhase(_vote) == VotePhase.Main;
    }

    function _hasVoted(Vote storage _vote, address _voter) internal view returns (bool) {
        VoterState state = _vote.voters[_voter];
        return state == VoterState.Yea || state == VoterState.Nay;
    }

    function _hasVotingPower(Vote storage _vote, address _voter) internal view returns (bool) {
        return token.balanceOfAt(_voter, _vote.snapshotBlock) > 0;
    }

    /**
    * @dev Internal function to get the current phase of the vote. It assumes the queried vote exists.
    * @return VotePhase.Main if one can vote 'yes' or 'no', VotePhase.Objection if one can vote only 'no' or VotePhase.Closed if no votes are accepted
    */
    function _getVotePhase(Vote storage vote_) internal view returns (VotePhase) {
        uint64 timestamp = getTimestamp64();
        uint64 voteTimeEnd = vote_.startDate.add(voteTime);
        if (timestamp < voteTimeEnd.sub(objectionPhaseTime)) {
            return VotePhase.Main;
        }
        if (timestamp < voteTimeEnd) {
            return VotePhase.Objection;
        }
        return VotePhase.Closed;
    }

    /**
    * @dev Internal function to check if a vote is still open for both support and objection
    * @return True if less than voteTime has passed since the vote start
    */
    function _isVoteOpen(Vote storage vote_) internal view returns (bool) {
        return getTimestamp64() < vote_.startDate.add(voteTime) && !vote_.executed;
    }

    /**
    * @dev Calculates whether `_value` is more than a percentage `_pct` of `_total`
    */
    function _isValuePct(uint256 _value, uint256 _total, uint256 _pct) internal pure returns (bool) {
        if (_total == 0) {
            return false;
        }

        uint256 computedPct = _value.mul(PCT_BASE) / _total;
        return computedPct > _pct;
    }
}
