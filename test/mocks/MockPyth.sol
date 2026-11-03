// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPyth, PythStructs} from "../../src/oracle/IPyth.sol";

/// @notice Pyth simulado: permite fijar precio, fecha y forzar que el oráculo no responda.
contract MockPyth is IPyth {
    mapping(bytes32 => PythStructs.Price) internal prices;
    bool public down;

    error PriceFeedNotFound();
    error OracleDown();

    function setPrice(bytes32 id, int64 price, uint64 conf, int32 expo, uint256 publishTime) external {
        prices[id] = PythStructs.Price(price, conf, expo, publishTime);
    }

    function setDown(bool down_) external {
        down = down_;
    }

    function getPriceUnsafe(bytes32 id) external view returns (PythStructs.Price memory) {
        if (down) revert OracleDown();
        if (prices[id].publishTime == 0) revert PriceFeedNotFound();
        return prices[id];
    }

    function updatePriceFeeds(bytes[] calldata) external payable {}

    function getUpdateFee(bytes[] calldata) external pure returns (uint256) {
        return 0;
    }
}
