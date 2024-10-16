pragma solidity 0.4.24;

import "../../Voting.sol";
import "@aragon/contract-helpers-test/contracts/0.4/aragonOS/TimeHelpersMock.sol";


contract VotingMock is Voting, TimeHelpersMock {
    // _isValuePct public wrapper
    function isValuePct(uint256 _value, uint256 _total, uint256 _pct) external pure returns (bool) {
        return _isValuePct(_value, _total, _pct);
    }

    // Mint a token and create a vote in the same transaction to test snapshot block values are correct
    function newTokenAndVote(address _holder, uint256 _tokenAmount, string _metadata)
        external
        returns (uint256 voteId)
    {
        token.generateTokens(_holder, _tokenAmount);

        bytes memory noScript = new bytes(0);
        voteId = _newVote(noScript, _metadata);
        emit StartVote(voteId, msg.sender, _metadata);
    }
}
