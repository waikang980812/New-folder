"use strict";

const creepsmod = require('creeps');
const pathing = require('pathing');
const scan = require('scan');
const taskconsts = require('tasks');
const taskhandling = require('taskhandling');
const utilities = require('utilities');


function getDensityRating(densityConstant) {
    const densities = [DENSITY_LOW, DENSITY_MODERATE, DENSITY_HIGH, DENSITY_ULTRA];
    return (densities.indexOf(densityConstant) + 1)/5;
}

function calculateWallRepairMeasure(room) {
    const prio = Math.max.apply(null, room.find(FIND_STRUCTURES)
        .filter(s => {
            return (s.structureType == STRUCTURE_WALL 
                // || s.structureType == STRUCTURE_RAMPART //To not repair/build rampart first
                )
                && s.hits < s.hitsMax;
        }).map(w => 1 - (w.hits/utilities.desiredWallHitpoints))) * 100;
    // prevent infinitely high prio (if no walls that match the filtering criteria were found)
    // return prio > 100 ? 0 : prio;
    return 1;
}

function calculateResourceMeasure(room) {
    const minerals = room.find(FIND_MINERALS);
    if (minerals.filter(mineral => {return Memory.desiredMinerals.includes(mineral.mineralType)}).length > 0) return 1;
    const mineralRatings = [];
    minerals.forEach(mineral => mineralRatings.push(getDensityRating(mineral.density)));
    const energyCount = room.find(FIND_SOURCES).length;

    const resourceMeasure = (energyCount/2 + mineralRatings.reduce((a, b) => a + b, 0.2))/2;
    if (resourceMeasure > 1) return 1;
    return resourceMeasure;
}

function calculateDefenseMeasure(room) {
    let towerEnergyQuotients = room.find(FIND_HOSTILE_STRUCTURES, {
        filter: scan.towerFilter
    }).map(tower => {
        return utilities.calcEnergyQuotient(tower);
    });
    const towerMeasure = towerEnergyQuotients.reduce((a, b) => a + b, 0)/3;

    let highestBodySize = 0;
    room.find(FIND_HOSTILE_CREEPS).forEach(creep => {
        if (creep.body.length > highestBodySize) highestBodySize = creep.body.length;
    });

    const prio = towerMeasure * highestBodySize/50;
    if (prio > 1) return 1;
    return prio;
}

let taskIdsToPriorityAllocators = {};
taskIdsToPriorityAllocators[taskconsts.tasks.ENERGY_HARVESTING.id] = function(room) {
    let prio = 0;
    const storage = room.find(FIND_MY_STRUCTURES, {
        filter: scan.storageFilter
    })[0];
    if (storage == undefined) {
        return 100;
    } else {
        console.log('['+room.name+'] '+'Energy Harvesting priority :' +((1 - utilities.calcEnergyQuotient(storage)) * 100));
        return (1 - utilities.calcEnergyQuotient(storage)) * 100;
    }
};
taskIdsToPriorityAllocators[taskconsts.tasks.ENERGY_TRANSFERRING.id] = function(room) {
    // if(room.controller.level > 4)
    // return (1 - utilities.calcSpawningEnergyQuotient(room)) * 100;
    // else
    return 90;
};
taskIdsToPriorityAllocators[taskconsts.tasks.CONTROLLER_UPGRADING.id] = function(room) {
    if (room.controller.ticksToDowngrade < 20000) return 100;
    return 90;
};
taskIdsToPriorityAllocators[taskconsts.tasks.BRUISER_DEFENSE_SPAWNING.id] = function(room, externalOverride = null) {
    if (room.controller.safeMode) return 0;
    const inherentPriority = scan.rampartDefenderNeeded(room, 2) ? 75 : 0;
    if (externalOverride != null) {
        if (externalOverride > inherentPriority) return externalOverride;
    }

    return inherentPriority;
};
taskIdsToPriorityAllocators[taskconsts.tasks.TOWER_CONSTRUCTION.id] = function(room) {
    return 100;
};
taskIdsToPriorityAllocators[taskconsts.tasks.EXTENSION_CONSTRUCTION.id] = function(room) {
    return utilities.calcSpawningEnergyQuotient(room) * 100;
};
// the room can't already be occupied by us and has to be visible
// (need a creep inside the room or an observer in range)
taskIdsToPriorityAllocators[taskconsts.tasks.INFLUENCE_EXPANSION.id] = function(room, pathCheckingPos) {
    if (room == undefined) {
        utilities.log('The influence expansion prio could not be calculated for a room. '
            + 'Presumably, a SCOUT was killed or there were not enough resources to spawn a SCOUT.', true);
        return {type: 'settling', prio: 0};
    }

    if (room.controller.safeMode != undefined) {
        return {type: 'settling', prio: 0};
    }

    const spawns = room.find(FIND_HOSTILE_SPAWNS);

    let resourceMeasure = calculateResourceMeasure(room);
    if (resourceMeasure > 0.5) resourceMeasure = 0.85;
    const getOwnerName = room => room.controller.owner.username;
    if (!room.controller.owner || getOwnerName(room) == getOwnerName(Game.rooms[Memory.occupiedRoomNames[0]]) || spawns.length == 0) {
        return {type: 'settling', prio: resourceMeasure * 100};
    } else {
        const blockingWallsExist = (pathCheckingPos, spawnToCheck) => {
            const path = pathing.getPathToRange(pathCheckingPos, [spawnToCheck], 1, true);
            return path == undefined || path.incomplete;
        };

        const prio = 1 - calculateDefenseMeasure(room);
        if (blockingWallsExist(pathCheckingPos, spawns[0])) {
            return {type: 'harassment', prio: prio * 100};
        } else {
            return {type: 'obliteration', prio: prio * 100};
        }
    }
};
taskIdsToPriorityAllocators[taskconsts.tasks.ROAD_CONSTRUCTION.id] = function(room) {
    if(
        room.find(FIND_CONSTRUCTION_SITES,{
            filter: struct => struct.structureType == STRUCTURE_ROAD || struct.structureType == STRUCTURE_CONTAINER
        }).length > 0
    )
    return 100;
    else return 0;
};
taskIdsToPriorityAllocators[taskconsts.tasks.WALL_CONSTRUCTION.id] = function(room) {
    // return 100; // lower prio
    // console.log('WALL CONSTRUCT room: '+JSON.stringify(room));
    // console.log(JSON.stringify(
    //    room.find(FIND_CONSTRUCTION_SITES,{
    //     filter: struct => struct.structureType == STRUCTURE_WALL
    //    }).length 
    // ));

    // if(room.find(FIND_CONSTRUCTION_SITES,{
    //     filter: struct => struct.structureType == STRUCTURE_WALL
    //    }).length > 0)
    //    return 90
    //    else
    return 1;
};
taskIdsToPriorityAllocators[taskconsts.tasks.TOWER_REFUELING.id] = function(room) {
    let towerEnergyQuotients = room.find(FIND_MY_STRUCTURES, {
        filter: scan.towerFilter
    }).map(tower => {
        return utilities.calcEnergyQuotient(tower)
    });
    let lowestQuotient = 1;
    towerEnergyQuotients.forEach(quotient => {
        if (quotient < lowestQuotient) lowestQuotient = quotient;
    });
    return (1 - lowestQuotient) * 100;
};
taskIdsToPriorityAllocators[taskconsts.tasks.STORAGE_CONSTRUCTION.id] = function(room) {
    const storageExists = room.find(FIND_MY_STRUCTURES, {
        filter: struct => struct.structureType == STRUCTURE_STORAGE
    }).length != 0;
    return storageExists ? 0 : 100;
}
// disabled, scouts are requested by the 'client' code directly by overwriting the scout spawning prio
taskIdsToPriorityAllocators[taskconsts.tasks.SCOUTING.id] = function(room) {
    return 0;
};
taskIdsToPriorityAllocators[taskconsts.tasks.WALL_REPAIRING.id] = calculateWallRepairMeasure;
taskIdsToPriorityAllocators[taskconsts.tasks.LINK_CONSTRUCTION.id] = function(room) {
    return 100;
};
taskIdsToPriorityAllocators[taskconsts.tasks.RECEIVER_OPERATION.id] = function(room) {
    // the assignment of this task should be completely static
    // setting the prio to 0 in order to avoid dynamic assignment
    return 0;
};

function applyPrioOverride(inherentPrio, override) {
    if (override == null) return inherentPrio;
    return inherentPrio > override ? inherentPrio : override;
}

function getPrioritizedControlTasks(room, unitTaskPriosAfterAssignmentHistory, bruiserSpawningOverride = null) {
    let prioritizedTasks = {};
    prioritizedTasks[taskconsts.tasks.BRUISER_DEFENSE_SPAWNING.id] = taskIdsToPriorityAllocators[taskconsts.tasks.BRUISER_DEFENSE_SPAWNING.id](
        room, bruiserSpawningOverride
    );

    if (unitTaskPriosAfterAssignmentHistory.length >= 3) {
        const taskIds = Object.keys(unitTaskPriosAfterAssignmentHistory[0]);
        for (let i = 0; i < taskIds.length; i++) {
            let prio = 0;
            let expansionTypes = null;
            const expansionRelated = taskIds[i] == taskconsts.tasks.INFLUENCE_EXPANSION.id;
            if (expansionRelated) expansionTypes = [];
            for (let j = 0; j < unitTaskPriosAfterAssignmentHistory.length; j++) {
                const taskInfo = unitTaskPriosAfterAssignmentHistory[j][taskIds[i]];
                prio += taskInfo.prio;
                if (expansionRelated) expansionTypes.push(taskInfo.type);
            }
            prio = prio/unitTaskPriosAfterAssignmentHistory.length;

            let spawningTaskId = null;
            if (expansionRelated) {
                const mostFrequentExpType = expansionTypes.sort((a, b) => {
                    return expansionTypes.filter(expType => expType === a)
                        .length - expansionTypes.filter(expType => expType === b).length;
                }).pop();

                if (Object.keys(taskhandling.attackSquadSpecifications).includes(mostFrequentExpType)) {
                    for (const spec of taskhandling.attackSquadSpecifications[mostFrequentExpType]) {
                        const [creeptype, minCount] = Object.entries(spec)[0];
                        const count = room.find(FIND_MY_CREEPS, {
                            filter: c => c.memory.type == creeptype
                        }).length;
                        if (count < minCount) {
                            spawningTaskId = taskhandling.creeptypesToSpawningTaskIds[
                                creeptype
                            ];
                            break;
                        }
                    }
                } else {
                    spawningTaskId = taskconsts.tasks.CLAIMER_SPAWNING.id;
                }

            } else {
                const creeptypes = taskhandling.assignmentTypesToCreeptypes[
                    taskconsts.getTaskById(parseInt(taskIds[i])).assignmentType
                ];
                if (creeptypes.length != 1) {
                    utilities.log('Ambiguous creeptype!', true);
                }
                spawningTaskId = taskhandling.creeptypesToSpawningTaskIds[creeptypes[0]][0];

            }

            if (prioritizedTasks[spawningTaskId] == undefined || prioritizedTasks[spawningTaskId] < prio) {
                prioritizedTasks[spawningTaskId] = prio;
            }
        }

    } else {
        utilities.log('The history of the unit-assignable task-prios was too short,'
            + ' no spawning prios (other than the bruiser-defense-prio) were calculated for room "'
            + room.name + '"', true);
    }

    return prioritizedTasks;

}

function getPrioritizedUnitTasks(room, roomToCheck, pathCheckingPos, externalOverrides = {}) {
    let prioritizedTasks = {};
    Object.values(taskconsts.tasks).forEach(task => {
        // console.log('looping task: '+JSON.stringify(task))
        if (task.assignmentType != null && task.assignmentType != taskconsts.assignmentTypes.SPAWN) {
            if (task.id == taskconsts.tasks.INFLUENCE_EXPANSION.id) {
                if (externalOverrides[task.id]) {
                    prioritizedTasks[task.id] = externalOverrides[task.id];
                    return;
                }
                let result = taskIdsToPriorityAllocators[task.id](roomToCheck, pathCheckingPos);
                prioritizedTasks[task.id] = result;
            } else {
                prioritizedTasks[task.id] = {
                    prio: applyPrioOverride(taskIdsToPriorityAllocators[
                        task.id
                    ](room), externalOverrides[task.id])
                };
            }
        }
    });
    // console.log('['+room.name+'] '+ 'Prioritized Tasks' )
    return prioritizedTasks;
}

// do not call this function for multiple rooms during the same tick (would be too CPU-intensive)
function getAllPrioritizedTasks(room, roomToCheck, pathCheckingPos, unitTaskPriosAfterAssignmentHistory, prioOverrides = {}) {
    let controlTasks = getPrioritizedControlTasks(
        room, unitTaskPriosAfterAssignmentHistory, prioOverrides[taskconsts.tasks.BRUISER_DEFENSE_SPAWNING.id]
    );
    let unitTasks = getPrioritizedUnitTasks(room, roomToCheck, pathCheckingPos, prioOverrides);

    // cutting off values above 100 (can happen bc of multipliers that are greater than 1)
    Object.keys(controlTasks).forEach(key => {
        if (controlTasks[key].prio > 100) controlTasks[key].prio = 100;
    });
    Object.keys(unitTasks).forEach(key => {
        if (unitTasks[key].prio > 100) unitTasks[key].prio = 100;
    });

    // console.log('['+room.name+'] '+'Unit Tasks: '+JSON.stringify(unitTasks));

    return {controlTasks: controlTasks, unitTasks: unitTasks};
}


let priorities = {

    handleDynamicTaskAssignment: function(room) {
        let setScoutSpawningPrio = false;

        if (Memory[room.name].prioHistory == undefined) Memory[room.name].prioHistory = [];
        const prioHistory = Memory[room.name].prioHistory;
        let prioOverrides = {};
        if (utilities.getMode(room) == 'siege') {
            prioOverrides[taskconsts.tasks.TOWER_CONSTRUCTION.id] = 50;
            prioOverrides[taskconsts.tasks.EXTENSION_CONSTRUCTION.id] = 50;
            prioOverrides[taskconsts.tasks.WALL_CONSTRUCTION.id] = 50;
            prioOverrides[taskconsts.tasks.STORAGE_CONSTRUCTION.id] = 50;
            prioOverrides[taskconsts.tasks.LINK_CONSTRUCTION.id] = 50;
        }
        const flag = utilities.getFlagToScout(room);
        let roomToCheck = null;
        let pathCheckingPos = null;
        const expansionTaskId = taskconsts.tasks.INFLUENCE_EXPANSION.id;
        if (flag == null) {
            prioOverrides[expansionTaskId] = {type: 'settling', prio: 0};
        } else {
            roomToCheck = flag.room;
            pathCheckingPos = flag.pos;
            if (roomToCheck == undefined) {
                if (prioHistory.length == 0) {
                    prioOverrides[expansionTaskId] = {type: 'settling', prio: 0};
                } else {
                    const lastExpansionPrioInfo = prioHistory[prioHistory.length - 1][expansionTaskId];
                    prioOverrides[expansionTaskId] = {type: lastExpansionPrioInfo.type, prio: lastExpansionPrioInfo.prio};
                }

                const idleScouts = room.find(FIND_MY_CREEPS, {
                    filter: creep => creep.memory.type == creepsmod.types.SCOUT && creep.memory.taskId === null
                });
                if (idleScouts.length == 0) {
                    const ticksSinceLastScoutPrio = Game.time - Memory[room.name].lastScoutPrioTick;
                    if ((isNaN(ticksSinceLastScoutPrio) || ticksSinceLastScoutPrio > 1000)
                        && room.find(FIND_MY_CREEPS, {filter: scan.workerFilter}).length > 0) {
                        setScoutSpawningPrio = true;
                    }
                } else {
                    idleScouts[0].memory.taskId = taskconsts.tasks.SCOUTING.id;
                    idleScouts[0].memory.scoutingTarget = flag.pos;
                }
            }
        }

        const result = getAllPrioritizedTasks(room, roomToCheck,
            pathCheckingPos, prioHistory, prioOverrides);
        let controlTasks = result.controlTasks;
        if (setScoutSpawningPrio) {
            Memory[room.name].lastScoutPrioTick = Game.time;
            if (controlTasks[taskconsts.tasks.SCOUT_SPAWNING.id] == undefined
                || controlTasks[taskconsts.tasks.SCOUT_SPAWNING.id] < 95) {
                controlTasks[taskconsts.tasks.SCOUT_SPAWNING.id] = 95;
            }
        }
        let unitTasks = result.unitTasks;
        const creeps = room.find(FIND_MY_CREEPS);
        taskhandling.assignTasksToCreeps(unitTasks, creeps);
        taskhandling.executeControlTasks(controlTasks, room);

        for (const taskId of Object.keys(unitTasks)) {
            if (Memory[room.name] != undefined && Memory[room.name].taskIdsToBlockageTimes != undefined
                && Object.keys(Memory[room.name].taskIdsToBlockageTimes).includes(taskId)) {
                unitTasks[taskId].prio = 0;
            }
        }

        if (prioHistory.length >= 3) {
            Memory[room.name].prioHistory.splice(0, prioHistory.length - 2);
        }

        Memory[room.name].prioHistory.push(unitTasks);
    }

};


module.exports = priorities;
