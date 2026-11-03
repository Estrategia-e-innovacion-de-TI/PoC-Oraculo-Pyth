// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IPyth, PythStructs} from "./IPyth.sol";

/// @title OracleAdapter
/// @notice Envuelve un feed de Pyth para un activo bursátil: normaliza el precio a 18 decimales
///         y clasifica su estado según antigüedad, confianza y horario de mercado.
contract OracleAdapter is Ownable {
    enum PriceStatus {
        Fresh, // mercado abierto y precio reciente
        MarketClosed, // mercado cerrado: último precio congelado, aún dentro de maxClosedAge
        Stale, // precio más antiguo de lo permitido
        Invalid, // precio <= 0 o intervalo de confianza demasiado amplio
        Unavailable // el oráculo revirtió / no responde
    }

    struct PriceData {
        uint256 price; // USD por unidad del activo, 18 decimales
        uint256 publishTime;
        PriceStatus status;
    }

    uint256 private constant SECONDS_PER_DAY = 1 days;

    IPyth public immutable pyth;
    bytes32 public immutable priceId;

    /// @notice Antigüedad máxima aceptada con el mercado abierto.
    uint256 public maxAge;
    /// @notice Antigüedad máxima del último precio con el mercado cerrado (p. ej. cubrir un fin de semana largo).
    uint256 public maxClosedAge;
    /// @notice Máximo conf/price en puntos básicos.
    uint256 public maxConfBps;

    /// @notice Sesión regular en segundos desde medianoche UTC (por defecto NYSE en horario de verano: 13:30-20:00 UTC).
    uint32 public sessionOpen = 13 hours + 30 minutes;
    uint32 public sessionClose = 20 hours;
    /// @notice Cierre forzado por feriados u otros eventos (lo opera un administrador).
    bool public forcedClosed;
    /// @notice Ignora el calendario (activos 24/7 como cripto, o demos). `forcedClosed` tiene prioridad.
    bool public alwaysOpen;

    event ParamsUpdated(uint256 maxAge, uint256 maxClosedAge, uint256 maxConfBps);
    event SessionUpdated(uint32 open, uint32 close);
    event ForcedClosedUpdated(bool closed);
    event AlwaysOpenUpdated(bool open);

    error InvalidSession();

    constructor(IPyth pyth_, bytes32 priceId_, uint256 maxAge_, uint256 maxClosedAge_, uint256 maxConfBps_)
        Ownable(msg.sender)
    {
        pyth = pyth_;
        priceId = priceId_;
        maxAge = maxAge_;
        maxClosedAge = maxClosedAge_;
        maxConfBps = maxConfBps_;
    }

    // ---------------------------------------------------------------- lectura

    /// @notice Devuelve precio normalizado, fecha de publicación y estado. Nunca revierte.
    function getPrice() public view returns (PriceData memory data) {
        PythStructs.Price memory p;
        try pyth.getPriceUnsafe(priceId) returns (PythStructs.Price memory result) {
            p = result;
        } catch {
            data.status = PriceStatus.Unavailable;
            return data;
        }

        data.publishTime = p.publishTime;
        if (p.price <= 0) {
            data.status = PriceStatus.Invalid;
            return data;
        }
        data.price = _scaleTo18(uint256(uint64(p.price)), p.expo);

        if (uint256(p.conf) * 10_000 > uint256(uint64(p.price)) * maxConfBps) {
            data.status = PriceStatus.Invalid;
            return data;
        }

        uint256 age = block.timestamp > p.publishTime ? block.timestamp - p.publishTime : 0;
        if (isMarketOpen(block.timestamp)) {
            data.status = age <= maxAge ? PriceStatus.Fresh : PriceStatus.Stale;
        } else {
            data.status = age <= maxClosedAge ? PriceStatus.MarketClosed : PriceStatus.Stale;
        }
    }

    /// @notice Lunes a viernes dentro de la sesión configurada y sin cierre forzado.
    function isMarketOpen(uint256 timestamp) public view returns (bool) {
        if (forcedClosed) return false;
        if (alwaysOpen) return true;
        // 1970-01-01 fue jueves -> 0 = domingo, 6 = sábado
        uint256 dayOfWeek = (timestamp / SECONDS_PER_DAY + 4) % 7;
        if (dayOfWeek == 0 || dayOfWeek == 6) return false;
        uint256 secondOfDay = timestamp % SECONDS_PER_DAY;
        return secondOfDay >= sessionOpen && secondOfDay < sessionClose;
    }

    // ---------------------------------------------------------------- admin

    function setParams(uint256 maxAge_, uint256 maxClosedAge_, uint256 maxConfBps_) external onlyOwner {
        maxAge = maxAge_;
        maxClosedAge = maxClosedAge_;
        maxConfBps = maxConfBps_;
        emit ParamsUpdated(maxAge_, maxClosedAge_, maxConfBps_);
    }

    /// @dev Permite ajustar el horario de verano/invierno de EE. UU. (14:30-21:00 UTC en invierno).
    function setSession(uint32 open_, uint32 close_) external onlyOwner {
        if (open_ >= close_ || close_ > SECONDS_PER_DAY) revert InvalidSession();
        sessionOpen = open_;
        sessionClose = close_;
        emit SessionUpdated(open_, close_);
    }

    function setForcedClosed(bool closed) external onlyOwner {
        forcedClosed = closed;
        emit ForcedClosedUpdated(closed);
    }

    function setAlwaysOpen(bool open_) external onlyOwner {
        alwaysOpen = open_;
        emit AlwaysOpenUpdated(open_);
    }

    // ---------------------------------------------------------------- internos

    function _scaleTo18(uint256 value, int32 expo) internal pure returns (uint256) {
        int256 shift = 18 + int256(expo);
        if (shift >= 0) return value * 10 ** uint256(shift);
        return value / 10 ** uint256(-shift);
    }
}
