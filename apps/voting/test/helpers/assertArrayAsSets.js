const { assert } = require('chai')
const { isAddress, isBN, toChecksumAddress } = require('web3-utils')

function normalizeArg(arg) {
    if (isBN(arg)) {
        return arg.toString();
    } else if (isAddress(arg)) {
        return toChecksumAddress(arg);
    } else if (arg && arg.address) {
        // Web3.js or Truffle contract instance
        return toChecksumAddress(arg.address);
    }

    return arg;
}
function assertArraysEqualAsSets(actual, expected, errorMsg) {
    actual = actual.map(normalizeArg);
    expected = expected.map(normalizeArg);

    const setActual = new Set(actual);
    const setExpected = new Set(expected);

    assert.equal(setActual.size, setExpected.size, errorMsg || "Arrays do not have the same length.");

    setActual.forEach(item => {
        assert.isTrue(setExpected.has(item), errorMsg || "Arrays do not match as sets.");
    });

    setExpected.forEach(item => {
        assert.isTrue(setActual.has(item), errorMsg || "Arrays do not match as sets.");
    });
}

module.exports = assertArraysEqualAsSets