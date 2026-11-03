// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {OracleAdapter} from "../src/oracle/OracleAdapter.sol";
import {TokenizedStockVault} from "../src/vault/TokenizedStockVault.sol";
import {MockPyth} from "./mocks/MockPyth.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

contract TokenizedStockVaultTest is Test {
    bytes32 constant AAPL = keccak256("Equity.US.AAPL/USD");
    uint256 constant WED_1500 = 1792594800;
    uint256 constant FRI_CLOSE = 1792785599;
    uint256 constant SAT_1500 = 1792854000;

    MockPyth pyth;
    MockUSDC usdc;
    OracleAdapter oracle;
    TokenizedStockVault vault;

    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    function setUp() public {
        vm.warp(WED_1500);
        pyth = new MockPyth();
        usdc = new MockUSDC();
        oracle = new OracleAdapter(pyth, AAPL, 5 minutes, 4 days, 100);
        vault = new TokenizedStockVault(usdc, oracle, "Vault AAPL", "vAAPL");

        _setPrice(200, block.timestamp);
        usdc.mint(alice, 10_000e6);
        usdc.mint(bob, 10_000e6);
        vm.prank(alice);
        usdc.approve(address(vault), type(uint256).max);
        vm.prank(bob);
        usdc.approve(address(vault), type(uint256).max);
    }

    function _setPrice(int64 dollars, uint256 publishTime) internal {
        pyth.setPrice(AAPL, dollars * 1e5, 1e4, -5, publishTime);
    }

    // ------------------------------------------------ criterio 3: valoración

    function test_DepositBuysUnitsAtOraclePrice() public {
        vm.prank(alice);
        uint256 shares = vault.deposit(1_000e6, alice);

        assertEq(shares, 1_000e6);
        assertEq(vault.stockUnits(), 5e18); // $1000 / $200 = 5 acciones
        assertEq(vault.totalAssets(), 1_000e6);
    }

    function test_SharePriceFollowsOracle() public {
        vm.prank(alice);
        vault.deposit(1_000e6, alice);

        vm.warp(WED_1500 + 1 hours);
        _setPrice(220, block.timestamp); // +10%

        (uint256 totalValue, uint256 sharePrice, uint256 publishTime, OracleAdapter.PriceStatus status) = vault.nav();
        assertEq(totalValue, 1_100e6);
        assertApproxEqAbs(sharePrice, 1.1e6, 1); // redondeo a la baja de ERC-4626
        assertEq(publishTime, block.timestamp);
        assertEq(uint8(status), uint8(OracleAdapter.PriceStatus.Fresh));
    }

    function test_LateDepositorGetsFewerShares() public {
        vm.prank(alice);
        vault.deposit(1_000e6, alice);

        _setPrice(250, block.timestamp);
        vm.prank(bob);
        uint256 bobShares = vault.deposit(1_000e6, bob);

        assertEq(bobShares, 800e6); // 1000 / 1.25
        assertEq(vault.stockUnits(), 9e18); // 5 + 4
    }

    function test_RedeemAfterGain() public {
        vm.prank(alice);
        vault.deposit(1_000e6, alice);

        _setPrice(220, block.timestamp);
        usdc.mint(address(vault), 100e6); // liquidación simulada del custodio (venta de la acción)

        vm.prank(alice);
        uint256 assets = vault.redeem(1_000e6, alice, alice);
        assertApproxEqAbs(assets, 1_100e6, 1);
        assertEq(vault.stockUnits(), 0);
    }

    // ------------------------------------------------ criterio 4: fuera de horario

    function test_WeekendBlocksByDefault() public {
        vm.prank(alice);
        vault.deposit(1_000e6, alice);

        _setPrice(200, FRI_CLOSE);
        vm.warp(SAT_1500);

        assertEq(vault.maxDeposit(bob), 0);
        assertEq(vault.maxRedeem(alice), 0);

        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(TokenizedStockVault.PriceNotUsable.selector, OracleAdapter.PriceStatus.MarketClosed)
        );
        vault.deposit(100e6, bob);

        // La valoración sigue disponible con el precio congelado del viernes
        (uint256 totalValue,,, OracleAdapter.PriceStatus status) = vault.nav();
        assertEq(totalValue, 1_000e6);
        assertEq(uint8(status), uint8(OracleAdapter.PriceStatus.MarketClosed));
    }

    function test_WeekendWithdrawalsAllowedByPolicy() public {
        vm.prank(alice);
        vault.deposit(1_000e6, alice);
        vault.setClosedMarketPolicy(false, true); // solo retiros con último precio

        _setPrice(200, FRI_CLOSE);
        vm.warp(SAT_1500);

        vm.prank(alice);
        vault.redeem(500e6, alice, alice);
        assertEq(vault.balanceOf(alice), 500e6);

        vm.prank(bob);
        vm.expectRevert();
        vault.deposit(100e6, bob);
    }

    function test_StalePriceBlocksEverything() public {
        vm.prank(alice);
        vault.deposit(1_000e6, alice);
        vault.setClosedMarketPolicy(true, true);

        vm.warp(WED_1500 + 10 minutes); // sin actualización en horario de mercado

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(TokenizedStockVault.PriceNotUsable.selector, OracleAdapter.PriceStatus.Stale)
        );
        vault.redeem(100e6, alice, alice);
    }

    function test_OracleDownBlocksAndNavReportsIt() public {
        vm.prank(alice);
        vault.deposit(1_000e6, alice);
        pyth.setDown(true);

        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(TokenizedStockVault.PriceNotUsable.selector, OracleAdapter.PriceStatus.Unavailable)
        );
        vault.deposit(100e6, bob);

        (uint256 totalValue, uint256 sharePrice,, OracleAdapter.PriceStatus status) = vault.nav();
        assertEq(totalValue, 0);
        assertEq(sharePrice, 0);
        assertEq(uint8(status), uint8(OracleAdapter.PriceStatus.Unavailable));

        vm.expectRevert(TokenizedStockVault.PriceUnavailable.selector);
        vault.totalAssets();
    }
}
