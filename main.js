"use strict";

const pathing = require('pathing');
const MoveException = pathing.MoveException;
const placement = require('placement');
const priorities = require('priorities');
const scan = require('scan');
const taskhandling = require('taskhandling');
const utilities = require('utilities');


function resizeRoomSpecificMemory() {
    const currentNames = scan.getRoomsViaSpawns().map(room => room.name);

    if (Memory.occupiedRoomNames) {
        for (const record of Memory.occupiedRoomNames) {
            if (!currentNames.includes(record)) delete Memory[record];
        }
    }

    for (const name of currentNames) {
        if (Memory[name] == undefined) Memory[name] = {};
    }
    Memory.occupiedRoomNames = currentNames;
}


module.exports.loop = function() {
    if (Memory.towerIds == undefined) {
        // place all code that should only run once here
        Memory.towerIds = [];
        // the elements of Memory.desiredMinerals have to be RESOURCE_* constants
        if (Memory.desiredMinerals == undefined) Memory.desiredMinerals = [];
        if (Memory.flagNamesToOccupyingForceNames == undefined) Memory.flagNamesToOccupyingForceNames = {};
        resizeRoomSpecificMemory();
        Memory.roomIndex = 0;
        Memory.roomActionIndex = -1;
        Memory.wallPlacingRoomIndex = -1;
        Memory.exitFinderIndex = -1;
        
    }

    


    if (Game.time % 83 == 0) {
        resizeRoomSpecificMemory();
    }

    // game objects can't be cached, so the rooms need to be retrieved every tick
    const occupiedRooms = Memory.occupiedRoomNames.map(roomName => Game.rooms[roomName]);

    utilities.saveRoomExits(occupiedRooms);

    for (const roomName of Object.values(Memory.occupiedRoomNames)) {
        if (!Memory[roomName].terrainWallDangerPositions) {
            Memory[roomName].terrainWallDangerPositions = pathing.getTerrainWallDangerPositions(Game.rooms[roomName]);
            // the calculations needed to populate the mem field are CPU-intensive (because of all the calls to 'room.lookAt')
            // => preventing CPU limit transgressions by ending the program prematurely this tick
            return;
        }
    }

    
    

    utilities.controlTowers();

    const linkOperationRoom = occupiedRooms[Game.time % occupiedRooms.length];
    utilities.controlLinks(scan.findSupplierLinks(linkOperationRoom), scan.findReceiverLinks(linkOperationRoom));

    if (Game.time % 3 == 0) {
        occupiedRooms.forEach(room => taskhandling.unblockTasks(room));
    }

    if (Game.time % 5 == 0) {
        occupiedRooms.forEach(room => {
            taskhandling.assignDefenseTask(room);
        });
    }

    if (Game.time % 7 == 0) {
        const actionIndex = utilities.getRoomActionIndex();
        const targetRoom = occupiedRooms[Memory.roomIndex];
        // console.log('Target Room: '+ JSON.stringify(occupiedRooms[Memory.roomIndex]));
        if (actionIndex == 0) {
            placement.placeRoads(targetRoom);
        } else if (actionIndex == 1) {
            placement.placeExtensions(targetRoom);
        } else if (actionIndex == 2) {
            placement.tryPlacingATower(targetRoom);
        } else {
            priorities.handleDynamicTaskAssignment(targetRoom);

            const newIndex = Memory.roomIndex + 1;
            if (newIndex <= Memory.occupiedRoomNames.length - 1) {
                Memory.roomIndex = newIndex;
            } else {
                Memory.roomIndex = 0;
            }
        }
    }

    if (Game.time % 11 == 0) {
        occupiedRooms.forEach(room => {
            // console.log(JSON.stringify(room));
            console.log( '['+room.name+'] - Energy available:' +
                room.energyAvailable + ' Energy Cap:'+room.energyCapacityAvailable + ' Energy not reach cap:' + JSON.stringify(room.energyAvailable < room.energyCapacityAvailable)
            )// debug here
        });
        utilities.cutMyLifeIntoPieces(occupiedRooms);
    }

    if (Game.time % 13 == 0) {
        occupiedRooms.forEach(room => {
            placement.protectRemoteStructures(room);
        });
    }

    if (Game.time % 29 == 0) {
        occupiedRooms.forEach(room => utilities.cleanupExpansionFlags(room));
    }

    if (Game.time % 31 == 0) {
        for (let i = 0; i < occupiedRooms.length; i++) {
            const room = occupiedRooms[i];
            if (utilities.getMode(room) == 'siege') {
                taskhandling.unblockTasks(room);

                // if the spawn of the given room is not busy, go through dynamic task assignment logic
                // (doing so raises the creep spawning frequency)
                if (room.find(FIND_MY_SPAWNS)[0].spawning == null) {
                    utilities.log('Calling the task assignment logic sooner than scheduled for room "' + room.name + '"');
                    priorities.handleDynamicTaskAssignment(room);
                    // preventing CPU limit transgressions by stopping the loop
                    break;
                }
            }
        }
    }

    if (Game.time % 37 == 0 && Game.time % 7 != 0) {
        const info = utilities.getWallPlacingInfo();
        placement.placeWalls(occupiedRooms[info['roomIndex']], info['exitFinderIndex']);
    }

    if (Game.time % 71 == 0) {
        utilities.resetBuilderFlags();
        utilities.resetRepairerFlags();
    }

    if (Game.time % 97 == 0) {
        let towerIds = [];
        for (let i = 0; i < occupiedRooms.length; i++) {
            towerIds = towerIds.concat(occupiedRooms[i].find(FIND_MY_STRUCTURES, {
                filter: scan.towerFilter
            }).map(tower => tower.id));
        }

        Memory.towerIds = towerIds;
    }

    if (Game.time % 109 == 0) {
        occupiedRooms.forEach(room => {
            utilities.resetSafExceptions(room);
        });
    }

    taskhandling.executeUnitTasks();

    occupiedRooms.forEach(room => taskhandling.manipulateCreepLifetimes(room));

    if (Game.time % 887 == 0) {
        for (const room of occupiedRooms) {
            // conserve CPU by breaking after the first demanding bit of logic has run
            if (placement.handleLinkPlacement(room)) break;
        }
    }

    // seems like the time (tick count) is reset periodically
    // the code below unblocks all blocked tasks to make sure no task is blocked forever
    // permanent worker death records are also prevented
    // (could occur due to a time reset)
    if (Game.time % 5119 == 0) {
        occupiedRooms.forEach(room => taskhandling.unblockTasks(room, true));
        utilities.refreshWorkerDeathRecords(occupiedRooms, true);
    }

    if (Game.time % 30341 == 0) {
        Memory.unsuitableForRemoteMining = [];
        occupiedRooms.forEach(room => placement.tryPlacingAStorage(room));
        occupiedRooms.forEach(room => utilities.clearAnchorBans(room));
    }
    // occupiedRooms.forEach(room => placement.tryPlacingAStorage(room));
    utilities.updateCreepRooms();
    utilities.refreshWorkerDeathRecords(occupiedRooms);
    utilities.clearDeadCreepsMemory(utilities.processCreepDeath);

    utilities.monitorCpu();

}
