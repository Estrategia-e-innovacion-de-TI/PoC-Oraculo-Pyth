// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {IPyth} from "../src/oracle/IPyth.sol";
import {OracleAdapter} from "../src/oracle/OracleAdapter.sol";
import {TokenizedStockVault} from "../src/vault/TokenizedStockVault.sol";
import {MockPyth} from "../test/mocks/MockPyth.sol";
import {MockUSDC} from "../test/mocks/MockUSDC.sol";

/// @notice Despliega el entorno de la demo:
///   - Bóveda ETH  -> OracleAdapter sobre el contrato REAL de Pyth (feed Crypto.ETH/USD, 24/7)
///   - Bóveda AAPL -> OracleAdapter sobre MockPyth (precio controlado desde la demo, horario NYSE)
/// Escribe las direcciones en app/deployments.json para el frontend.
contract Deploy is Script {
    bytes32 constant ETH_USD = 0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace;
    bytes32 constant AAPL_SIM = keccak256("Equity.US.AAPL/USD (simulado)");

    // Cuentas por defecto de Anvil que reciben mUSDC
    address[3] internal demoAccounts = [
        0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266,
        0x70997970C51812dc3A010C7d01b50e0d17dc79C8,
        0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC
    ];

    function run() external {
        address pyth = vm.envOr("PYTH_ADDRESS", vm.parseAddress("0xa2aa501b19aff244d90cc15a4cf739d2725b5729"));
        uint256 maxAge = vm.envOr("DEMO_MAX_AGE", uint256(2 minutes));

        vm.startBroadcast();

        MockUSDC usdc = new MockUSDC();
        for (uint256 i; i < demoAccounts.length; i++) {
            usdc.mint(demoAccounts[i], 10_000e6);
        }

        OracleAdapter ethOracle = new OracleAdapter(IPyth(pyth), ETH_USD, maxAge, 4 days, 100);
        ethOracle.setAlwaysOpen(true);
        TokenizedStockVault ethVault = new TokenizedStockVault(usdc, ethOracle, "Vault ETH", "vETH");

        MockPyth mockPyth = new MockPyth();
        mockPyth.setPrice(AAPL_SIM, 225_00000, 1_0000, -5, block.timestamp); // USD 225.00
        OracleAdapter aaplOracle = new OracleAdapter(mockPyth, AAPL_SIM, maxAge, 4 days, 100);
        TokenizedStockVault aaplVault = new TokenizedStockVault(usdc, aaplOracle, "Vault AAPL", "vAAPL");

        vm.stopBroadcast();

        string memory o = "deployments";
        vm.serializeUint(o, "chainId", block.chainid);
        vm.serializeAddress(o, "usdc", address(usdc));
        vm.serializeAddress(o, "pyth", pyth);
        vm.serializeBytes32(o, "ethPriceId", ETH_USD);
        vm.serializeAddress(o, "ethOracle", address(ethOracle));
        vm.serializeAddress(o, "ethVault", address(ethVault));
        vm.serializeAddress(o, "mockPyth", address(mockPyth));
        vm.serializeBytes32(o, "aaplPriceId", AAPL_SIM);
        vm.serializeAddress(o, "aaplOracle", address(aaplOracle));
        string memory json = vm.serializeAddress(o, "aaplVault", address(aaplVault));
        vm.writeJson(json, "./app/deployments.json");

        console.log("mUSDC      ", address(usdc));
        console.log("Vault ETH  ", address(ethVault), "oracle", address(ethOracle));
        console.log("Vault AAPL ", address(aaplVault), "oracle", address(aaplOracle));
        console.log("MockPyth   ", address(mockPyth));
    }
}
