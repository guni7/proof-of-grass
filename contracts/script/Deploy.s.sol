// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/SignalToken.sol";
import "../src/GodEye.sol";

contract DeployScript is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(deployerPrivateKey);

        SignalToken token = new SignalToken();
        GodEye manager = new GodEye(address(token));
        
        token.transferOwnership(address(manager));

        console.log("SignalToken deployed at:", address(token));
        console.log("GodEye manager deployed at:", address(manager));

        vm.stopBroadcast();
    }
}
