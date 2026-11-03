// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {OracleAdapter} from "../oracle/OracleAdapter.sol";

/// @title TokenizedStockVault
/// @notice Bóveda ERC-4626 síncrona (modelo respaldado) que recibe una stablecoin y mantiene
///         exposición a una acción. El valor de la participación se calcula con el precio del oráculo:
///         totalAssets = stockUnits * precio ; valorParticipación = totalAssets / totalSupply.
/// @dev PoC: la compra/venta del subyacente por el custodio se simula registrando `stockUnits`.
///      Las ganancias en USDC deben ser liquidadas por el custodio (en los tests se acuña USDC a la bóveda).
contract TokenizedStockVault is ERC4626, Ownable {
    using Math for uint256;

    OracleAdapter public immutable oracle;
    uint256 private immutable _assetScale; // 10^(18 - decimales del activo)

    /// @notice Unidades del activo subyacente en custodia (18 decimales).
    uint256 public stockUnits;

    /// @notice Política fuera de horario: si se aceptan operaciones con el último precio congelado.
    bool public depositsWhenClosed;
    bool public withdrawalsWhenClosed;

    event StockBought(uint256 assets, uint256 units, uint256 price);
    event StockSold(uint256 assets, uint256 units, uint256 price);
    event ClosedMarketPolicyUpdated(bool deposits, bool withdrawals);

    error PriceNotUsable(OracleAdapter.PriceStatus status);
    error PriceUnavailable();

    constructor(IERC20Metadata asset_, OracleAdapter oracle_, string memory name_, string memory symbol_)
        ERC20(name_, symbol_)
        ERC4626(asset_)
        Ownable(msg.sender)
    {
        oracle = oracle_;
        _assetScale = 10 ** (18 - asset_.decimals());
    }

    // ---------------------------------------------------------------- valoración

    /// @notice Valor de la cartera en unidades del activo de depósito (p. ej. USDC con 6 decimales).
    function totalAssets() public view override returns (uint256) {
        if (stockUnits == 0) return 0;
        OracleAdapter.PriceData memory p = oracle.getPrice();
        if (p.price == 0) revert PriceUnavailable();
        return stockUnits.mulDiv(p.price, 1e18) / _assetScale;
    }

    /// @notice Resumen de valoración: NAV, valor de una participación, fecha del precio y estado.
    function nav()
        external
        view
        returns (uint256 totalValue, uint256 sharePrice, uint256 publishTime, OracleAdapter.PriceStatus status)
    {
        OracleAdapter.PriceData memory p = oracle.getPrice();
        publishTime = p.publishTime;
        status = p.status;
        if (p.price == 0) return (0, 0, publishTime, status);
        totalValue = totalAssets();
        sharePrice = convertToAssets(10 ** decimals());
    }

    // ---------------------------------------------------------------- límites ERC-4626

    function maxDeposit(address receiver) public view override returns (uint256) {
        return _isUsable(true) ? super.maxDeposit(receiver) : 0;
    }

    function maxMint(address receiver) public view override returns (uint256) {
        return _isUsable(true) ? super.maxMint(receiver) : 0;
    }

    function maxWithdraw(address owner_) public view override returns (uint256) {
        return _isUsable(false) ? super.maxWithdraw(owner_) : 0;
    }

    function maxRedeem(address owner_) public view override returns (uint256) {
        return _isUsable(false) ? super.maxRedeem(owner_) : 0;
    }

    // ---------------------------------------------------------------- operaciones

    function deposit(uint256 assets, address receiver) public override returns (uint256) {
        _requireUsable(true);
        return super.deposit(assets, receiver);
    }

    function mint(uint256 shares, address receiver) public override returns (uint256) {
        _requireUsable(true);
        return super.mint(shares, receiver);
    }

    function withdraw(uint256 assets, address receiver, address owner_) public override returns (uint256) {
        _requireUsable(false);
        return super.withdraw(assets, receiver, owner_);
    }

    function redeem(uint256 shares, address receiver, address owner_) public override returns (uint256) {
        _requireUsable(false);
        return super.redeem(shares, receiver, owner_);
    }

    function _deposit(address caller, address receiver, uint256 assets, uint256 shares) internal override {
        super._deposit(caller, receiver, assets, shares);
        uint256 price = oracle.getPrice().price;
        uint256 units = (assets * _assetScale).mulDiv(1e18, price);
        stockUnits += units;
        emit StockBought(assets, units, price);
    }

    function _withdraw(address caller, address receiver, address owner_, uint256 assets, uint256 shares)
        internal
        override
    {
        uint256 units = stockUnits.mulDiv(shares, totalSupply());
        stockUnits -= units;
        emit StockSold(assets, units, oracle.getPrice().price);
        super._withdraw(caller, receiver, owner_, assets, shares);
    }

    // ---------------------------------------------------------------- admin

    function setClosedMarketPolicy(bool deposits, bool withdrawals) external onlyOwner {
        depositsWhenClosed = deposits;
        withdrawalsWhenClosed = withdrawals;
        emit ClosedMarketPolicyUpdated(deposits, withdrawals);
    }

    // ---------------------------------------------------------------- internos

    function _isUsable(bool isDeposit) internal view returns (bool) {
        OracleAdapter.PriceStatus s = oracle.getPrice().status;
        if (s == OracleAdapter.PriceStatus.Fresh) return true;
        if (s == OracleAdapter.PriceStatus.MarketClosed) return isDeposit ? depositsWhenClosed : withdrawalsWhenClosed;
        return false;
    }

    function _requireUsable(bool isDeposit) internal view {
        if (!_isUsable(isDeposit)) revert PriceNotUsable(oracle.getPrice().status);
    }
}
