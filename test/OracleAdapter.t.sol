// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {OracleAdapter} from "../src/oracle/OracleAdapter.sol";
import {MockPyth} from "./mocks/MockPyth.sol";

contract OracleAdapterTest is Test {
    bytes32 constant AAPL = keccak256("Equity.US.AAPL/USD");

    // Fechas fijas (UTC)
    uint256 constant WED_1500 = 1792594800; // miércoles 2026-10-21 15:00, mercado abierto
    uint256 constant FRI_CLOSE = 1792785599; // viernes 2026-10-23 19:59:59, último segundo de sesión
    uint256 constant SAT_1500 = 1792854000; // sábado 2026-10-24 15:00, mercado cerrado

    MockPyth pyth;
    OracleAdapter oracle;

    function setUp() public {
        pyth = new MockPyth();
        // maxAge 5 min, maxClosedAge 4 días, conf máx 1% (100 bps)
        oracle = new OracleAdapter(pyth, AAPL, 5 minutes, 4 days, 100);
    }

    function test_FreshPriceIsScaledTo18Decimals() public {
        vm.warp(WED_1500);
        pyth.setPrice(AAPL, 22_512_345, 10_000, -5, WED_1500 - 10); // $225.12345

        OracleAdapter.PriceData memory p = oracle.getPrice();
        assertEq(p.price, 225.12345e18);
        assertEq(p.publishTime, WED_1500 - 10);
        assertEq(uint8(p.status), uint8(OracleAdapter.PriceStatus.Fresh));
    }

    function test_StaleWhileMarketOpen() public {
        vm.warp(WED_1500);
        pyth.setPrice(AAPL, 22_500_000, 10_000, -5, WED_1500 - 6 minutes);
        assertEq(uint8(oracle.getPrice().status), uint8(OracleAdapter.PriceStatus.Stale));
    }

    function test_WeekendKeepsFridayPriceAsMarketClosed() public {
        pyth.setPrice(AAPL, 22_500_000, 10_000, -5, FRI_CLOSE);
        vm.warp(SAT_1500);

        OracleAdapter.PriceData memory p = oracle.getPrice();
        assertEq(p.price, 225e18);
        assertEq(uint8(p.status), uint8(OracleAdapter.PriceStatus.MarketClosed));
    }

    function test_ClosedMarketPriceExpiresAfterMaxClosedAge() public {
        pyth.setPrice(AAPL, 22_500_000, 10_000, -5, FRI_CLOSE);
        vm.warp(FRI_CLOSE + 4 days + 1); // martes 20:00 UTC, fuera de sesión
        assertEq(uint8(oracle.getPrice().status), uint8(OracleAdapter.PriceStatus.Stale));
    }

    function test_HolidayForcedClosed() public {
        vm.warp(WED_1500);
        pyth.setPrice(AAPL, 22_500_000, 10_000, -5, WED_1500 - 1 hours);
        oracle.setForcedClosed(true);
        assertEq(uint8(oracle.getPrice().status), uint8(OracleAdapter.PriceStatus.MarketClosed));
    }

    function test_AlwaysOpenIgnoresScheduleButNotForcedClose() public {
        oracle.setAlwaysOpen(true);
        assertTrue(oracle.isMarketOpen(SAT_1500));

        oracle.setForcedClosed(true);
        assertFalse(oracle.isMarketOpen(SAT_1500));
    }

    function test_UnavailableWhenOracleReverts() public {
        vm.warp(WED_1500);
        pyth.setPrice(AAPL, 22_500_000, 10_000, -5, WED_1500);
        pyth.setDown(true);

        OracleAdapter.PriceData memory p = oracle.getPrice();
        assertEq(p.price, 0);
        assertEq(uint8(p.status), uint8(OracleAdapter.PriceStatus.Unavailable));
    }

    function test_UnavailableWhenFeedNotFound() public {
        vm.warp(WED_1500);
        assertEq(uint8(oracle.getPrice().status), uint8(OracleAdapter.PriceStatus.Unavailable));
    }

    function test_InvalidWhenNonPositive() public {
        vm.warp(WED_1500);
        pyth.setPrice(AAPL, 0, 0, -5, WED_1500);
        assertEq(uint8(oracle.getPrice().status), uint8(OracleAdapter.PriceStatus.Invalid));
    }

    function test_InvalidWhenConfidenceTooWide() public {
        vm.warp(WED_1500);
        pyth.setPrice(AAPL, 22_500_000, 300_000, -5, WED_1500); // conf $3 sobre $225 = 1.33%
        assertEq(uint8(oracle.getPrice().status), uint8(OracleAdapter.PriceStatus.Invalid));
    }

    function test_MarketHoursBoundaries() public view {
        assertTrue(oracle.isMarketOpen(WED_1500));
        assertTrue(oracle.isMarketOpen(FRI_CLOSE));
        assertFalse(oracle.isMarketOpen(FRI_CLOSE + 1)); // viernes 20:00
        assertFalse(oracle.isMarketOpen(SAT_1500));
        assertFalse(oracle.isMarketOpen(WED_1500 - 2 hours)); // 13:00, antes de la apertura
    }

    function test_OnlyOwnerCanChangeSession() public {
        vm.prank(address(0xBEEF));
        vm.expectRevert();
        oracle.setSession(14 hours + 30 minutes, 21 hours);

        oracle.setSession(14 hours + 30 minutes, 21 hours); // horario de invierno
        assertFalse(oracle.isMarketOpen(WED_1500 - 45 minutes)); // 14:15, antes de la apertura de las 14:30
        assertTrue(oracle.isMarketOpen(WED_1500 - 30 minutes)); // 14:30
    }
}
