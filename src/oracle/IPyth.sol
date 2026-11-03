// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Subconjunto mínimo de la interfaz de Pyth (ABI compatible con el contrato real).
/// @dev Se evita depender del SDK completo; solo se usan las funciones necesarias para la PoC.
library PythStructs {
    struct Price {
        int64 price; // precio = price * 10^expo
        uint64 conf; // intervalo de confianza, misma escala que price
        int32 expo;
        uint256 publishTime; // timestamp unix de publicación en la fuente
    }
}

interface IPyth {
    /// @notice Último precio guardado on-chain, sin validar antigüedad. Revierte si el feed no existe.
    function getPriceUnsafe(bytes32 id) external view returns (PythStructs.Price memory price);

    /// @notice Publica actualizaciones firmadas obtenidas desde Hermes (modelo pull).
    function updatePriceFeeds(bytes[] calldata updateData) external payable;

    function getUpdateFee(bytes[] calldata updateData) external view returns (uint256 feeAmount);
}
