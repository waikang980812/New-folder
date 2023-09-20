"use strict";

const creeps = require('creeps');
const MissingEnergyForSpawningException = creeps.MissingEnergyForSpawningException;
const pathing = require('pathing');
const MoveException = pathing.MoveException;
const MoveSafetyException = pathing.MoveSafetyException;
const scan = require('scan');
const taskexecution = require('taskexecution');
const taskconsts = require('tasks');
const utilities = require('utilities');


const taskBlockageDuration = 100;
const taskContinuationBias = 10;


let assignmentTypesToCreeptypes = {};
assignmentTypesToCreeptypes[taskconsts.assignmentTypes.SPAWN] = null;
assignmentTypesToCreeptypes[taskconsts.assignmentTypes.CLAIMER] = [creeps.types.CLAIMER];
assignmentTypesToCreeptypes[taskconsts.assignmentTypes.SCOUT] = [creeps.types.SCOUT];
assignmentTypesToCreeptypes[taskconsts.assignmentTypes.SOLDIER] = [
    creeps.types.BRUISER,
    creeps.types.MARKSMAN,
    creeps.types.MEDIC,
    creeps.types.DEMOLISHER,
    creeps.types.TANK
];
assignmentTypesToCreeptypes[taskconsts.assignmentTypes.WORKER] = [creeps.types.WORKER];

// not using demolishers here since deconstructing walls leaves energy
// that can then be used by the enemy between attacks to reinforce the walls again
let harassmentSpec = [{}, {}, {}, {}];
harassmentSpec[0][creeps.types.MEDIC] = 4;
harassmentSpec[1][creeps.types.TANK] = 1;
harassmentSpec[2][creeps.types.BRUISER] = 1;
harassmentSpec[3][creeps.types.MARKSMAN] = 1;

let obliterationSpec = [{}, {}, {}, {}];
obliterationSpec[0][creeps.types.MEDIC] = 4;
obliterationSpec[1][creeps.types.TANK] = 1;
obliterationSpec[2][creeps.types.DEMOLISHER] = 1;
obliterationSpec[3][creeps.types.MARKSMAN] = 1;

const attackSquadSpecifications = {
    harassment: harassmentSpec,
    obliteration: obliterationSpec
};

let creeptypesToSpawningTaskIds = {};
creeptypesToSpawningTaskIds[creeps.types.BRUISER] = [taskconsts.tasks.BRUISER_SPAWNING.id, taskconsts.tasks.BRUISER_DEFENSE_SPAWNING.id];
creeptypesToSpawningTaskIds[creeps.types.CLAIMER] = [taskconsts.tasks.CLAIMER_SPAWNING.id];
creeptypesToSpawningTaskIds[creeps.types.MARKSMAN] = [taskconsts.tasks.MARKSMAN_SPAWNING.id];
creeptypesToSpawningTaskIds[creeps.types.MEDIC] = [taskconsts.tasks.MEDIC_SPAWNING.id];
creeptypesToSpawningTaskIds[creeps.types.SCOUT] = [taskconsts.tasks.SCOUT_SPAWNING.id];
creeptypesToSpawningTaskIds[creeps.types.WORKER] = [taskconsts.tasks.WORKER_SPAWNING.id];
creeptypesToSpawningTaskIds[creeps.types.DEMOLISHER] = [taskconsts.tasks.DEMOLISHER_SPAWNING.id];
creeptypesToSpawningTaskIds[creeps.types.TANK] = [taskconsts.tasks.TANK_SPAWNING.id];

function attackSquadAssembled(room, type) {
    for (const spec of attackSquadSpecifications[type]) {
        const [creeptype, minCount] = Object.entries(spec)[0];
        const count = room.find(FIND_MY_CREEPS, {
            filter: c => c.memory.type == creeptype
        }).length;
        if (count < minCount) return false;
    }

    return true;
}

function cleanUpMemProps(creep) {
    delete creep.memory.building;
    delete creep.memory.repairing;
}

function creepSuitable(taskId, taskInfo, creep) {
    // prevent creeps returning from/travelling to remote mining ops from becoming stuck
    if (creep.memory.miningReturnTarget) return false;

    if (taskId == taskconsts.tasks.CREEP_DEFENSE.id) return false; // assignment does not happen via prio sys

    // ready for settling
    const targetRoomReady = room => {
        const flag = utilities.getFlagToScout(room);
        if (flag == undefined || flag.room == undefined) return false;
        return utilities.roomSuitableForRemoteMining(flag.room, [creep.owner.username]) && flag.room.controller.owner;
    };

    if (taskId == taskconsts.tasks.INFLUENCE_EXPANSION.id && taskInfo.type == 'settling') {
        return creep.memory.type == creeps.types.CLAIMER
            || creep.memory.type == creeps.types.WORKER && targetRoomReady(creep.room)
    }
    const unitTask = taskconsts.getTaskById(taskId);
    return assignmentTypesToCreeptypes[unitTask.assignmentType].includes(parseInt(creep.memory.type));
}

function getMaxPrioTaskInfo(prioritizedUnitTasks, creep) {
    let highestPrio = -1;
    let relevantTaskId = null;
    for (const [taskId, taskInfo] of Object.entries(prioritizedUnitTasks)) {
        if (creepSuitable(parseInt(taskId), taskInfo, creep)) {
            if (Memory[creep.room.name] != undefined && Memory[creep.room.name].taskIdsToBlockageTimes != undefined
                && Object.keys(Memory[creep.room.name].taskIdsToBlockageTimes).includes(taskId)) {
                continue;
            } else if (taskInfo.prio >= highestPrio) {
                highestPrio = taskInfo.prio;
                relevantTaskId = taskId;
            }
        }
    }

    if (highestPrio < 5 && creepSuitable(taskconsts.tasks.CONTROLLER_UPGRADING.id, null, creep)) {
        return {taskId: taskconsts.tasks.CONTROLLER_UPGRADING.id, prio: 20};
    } else {
        return {taskId: relevantTaskId, prio: highestPrio};
    }
}

function decrementTaskPrio(tasks, taskId) {
    if (tasks[taskId].prio - 15 < 0) {
        tasks[taskId].prio = 0;
    } else {
        tasks[taskId].prio = tasks[taskId].prio - 15;
    }
}

function updateAssignment(prioritizedUnitTasks, creep) {
    const result = getMaxPrioTaskInfo(prioritizedUnitTasks, creep);
    if (result.taskId == null) return;

    if (result.taskId == taskconsts.tasks.INFLUENCE_EXPANSION.id && prioritizedUnitTasks[result.taskId].type != 'settling') {
        if (!attackSquadAssembled(creep.room, prioritizedUnitTasks[result.taskId].type)) return;
    }

    if (prioritizedUnitTasks[creep.memory.taskId] == undefined || result.prio - prioritizedUnitTasks[creep.memory.taskId].prio > taskContinuationBias) {
        cleanUpMemProps(creep);
        creep.memory.taskId = result.taskId;
        decrementTaskPrio(prioritizedUnitTasks, result.taskId);
    } else {
        decrementTaskPrio(prioritizedUnitTasks, creep.memory.taskId);
    }
}

function assignHighestPrioTask(prioritizedUnitTasks, creep) {
    const taskId = getMaxPrioTaskInfo(prioritizedUnitTasks, creep).taskId;
    if (taskId == null) return;

    if (taskId == taskconsts.tasks.INFLUENCE_EXPANSION.id && prioritizedUnitTasks[taskId].type != 'settling') {
        if (!attackSquadAssembled(creep.room, prioritizedUnitTasks[taskId].type)) return;
    }

    cleanUpMemProps(creep);
    creep.memory.taskId = taskId;
    decrementTaskPrio(prioritizedUnitTasks, taskId);
}

function reassign(creep) {
    if (Memory[creep.room.name] == undefined) return;
    const prioHistory = Memory[creep.room.name].prioHistory;
    if (prioHistory == undefined || prioHistory.length == 0) return;
    let lastAssignmentPrios = prioHistory[prioHistory.length - 1];
    assignHighestPrioTask(lastAssignmentPrios, creep);
    Memory[creep.room.name].prioHistory[prioHistory.length - 1] = lastAssignmentPrios;

    if (creep.memory.oldTaskId == undefined) return;

    // set all prio records of the task that caused the creep to idle to 0
    // to prevent assignments to that task in the near future (in the given room)
    for (let i = 0; i < prioHistory.length; i++) {
        Memory[creep.room.name].prioHistory[i][creep.memory.oldTaskId].prio = 0;
    }
}

function executeSpawningTasks(taskPrios, room) {
    let highestPrio = 0;
    let relevantId = null;
    for (const [spawningTaskId, prio] of Object.entries(taskPrios)) {
        if (prio >= highestPrio) {
            highestPrio = prio;
            relevantId = spawningTaskId;
        }
    }

    let wantedType = null;
    for (const [type, ids] of Object.entries(creeptypesToSpawningTaskIds)) {
        if (ids.includes(parseInt(relevantId))) {
            wantedType = type;
            break;
        }
    }
    if (wantedType == null) {
        utilities.log('No creeptype is associated to the spawning task with id: '
            + relevantId + '.', true);
        return;
    } else if (wantedType == creeps.types.WORKER) {
        const spawn = room.find(FIND_MY_SPAWNS)[0];
        let workerCount = 0;
        for (const name in Game.creeps) {
            if (name.startsWith(spawn.name) && scan.workerFilter(Game.creeps[name])) {
                workerCount++;
            }
        }

        if (workerCount >= utilities.calcMaxWorkers(room)) return;
    }

    try {
        creeps.spawnCreep(room, wantedType);
    } catch (e) {
        if (e instanceof MissingEnergyForSpawningException) {
            utilities.log('The spawn in room "' + room.name
                + '" does not have enough energy to spawn a creep of type "'
                + wantedType + '"');
        } else {
            throw e;
        }
    }
}


let taskhandling = {

    assignmentTypesToCreeptypes: assignmentTypesToCreeptypes,

    creeptypesToSpawningTaskIds: creeptypesToSpawningTaskIds,

    attackSquadSpecifications: attackSquadSpecifications,

    // relies on all creeps being in the same room
    assignTasksToCreeps: function(prioritizedUnitTasks, targetCreeps) {
        if (targetCreeps.length == 0) return;
        const room = targetCreeps[0].room;

        // set the value to false initially, since the transferring assignment is not static
        let assignedEnergyTransfers = false;

        const storage = room.find(FIND_MY_STRUCTURES, {filter: scan.storageFilter})[0];
        // throttle ctrl upgrading if economy unstable
        let assignedCtrlUpgrading = storage && storage.store[RESOURCE_ENERGY] <= 200000 && room.controller.ticksToDowngrade >= 2000;

        if (!assignedCtrlUpgrading) {
            assignedCtrlUpgrading = targetCreeps.filter(creep => {
                return creep.memory.taskId == taskconsts.tasks.CONTROLLER_UPGRADING.id
            }).length > 0;
        }
        if (assignedCtrlUpgrading) prioritizedUnitTasks[taskconsts.tasks.CONTROLLER_UPGRADING.id].prio = 0;


        let assignedReceiverOperation = storage && storage.store[RESOURCE_ENERGY] <= 25000 && !scan.containsEnemies(room);
        if (!assignedReceiverOperation) {
            assignedReceiverOperation = targetCreeps.filter(creep => {
                return creep.memory.taskId == taskconsts.tasks.RECEIVER_OPERATION.id
            }).length > 0;
        }
        if (assignedReceiverOperation) prioritizedUnitTasks[taskconsts.tasks.RECEIVER_OPERATION.id].prio = 0;

        let filteredCreeps = targetCreeps.filter(creep => {
            // automatic SCOUT assignment is disabled, the code that wants to scout a location has to assign itself
            return creep.memory.type != creeps.types.SCOUT
                && !creep.memory.staticallyAssigned
                && !creep.memory.miningReturnTarget // prevent creeps returning from/travelling to remote mining ops from becoming stuck
        });

        if (!assignedCtrlUpgrading && filteredCreeps.length > 1) {
            const weakestIndex = utilities.getElementIndex('min')(filteredCreeps.map(c => c.body.length));
            const tmp = filteredCreeps[weakestIndex];
            filteredCreeps[weakestIndex] = filteredCreeps[1];
            filteredCreeps[1] = tmp;
        }

        for (let i = 0; i < filteredCreeps.length; i++) {
            const creep = filteredCreeps[i];

            if (!assignedEnergyTransfers && creep.memory.type == creeps.types.WORKER) {
                assignedEnergyTransfers = true;
                creep.memory.noIdling = true;
                cleanUpMemProps(creep);

                // assigning to ctrl upgrade instead if no storage exists
                const storageExists = room.find(FIND_MY_STRUCTURES, {filter: scan.storageFilter}).length > 0;
                creep.memory.taskId = storageExists ? taskconsts.tasks.ENERGY_TRANSFERRING.id : taskconsts.tasks.CONTROLLER_UPGRADING.id;
                continue;
            }

            if (!assignedCtrlUpgrading && creep.memory.type == creeps.types.WORKER) {
                assignedCtrlUpgrading = true;
                creep.memory.noIdling = true;
                creep.memory.staticallyAssigned = true;
                cleanUpMemProps(creep);
                creep.memory.taskId = taskconsts.tasks.CONTROLLER_UPGRADING.id;
                prioritizedUnitTasks[taskconsts.tasks.CONTROLLER_UPGRADING.id].prio = 0;
                continue;
            }

            if (!assignedReceiverOperation && creep.memory.type == creeps.types.WORKER) {
                const getMinElementIndex = utilities.getElementIndex('min');

                let receivers = scan.findReceiverLinks(room);
                if (Memory[room.name].placedCtrlLink && receivers.length > 0) {
                    let measurements = [];
                    receivers.forEach(receiver => {
                        const result = pathing.getPathToRange(receiver.pos, [room.controller], 1, true);
                        if (!result.incomplete && result.path != undefined) {
                            measurements.push(result.path.cost);
                        } else {
                            measurements.push(100000);
                        }

                        receivers.splice(getMinElementIndex(measurements), 1);
                    });
                }

                if (receivers.length > 0) {
                    if (scan.containsEnemies(room)) {
                        const getMinHostileRange = struct => {
                            return struct.pos.getRangeTo(struct.pos.findClosestByRange(FIND_HOSTILE_CREEPS).pos);
                        };
                        creep.memory.sourceLink = receivers[
                            getMinElementIndex(receivers.map(receiver => getMinHostileRange(receiver)))
                        ].pos;
                    } else {
                        creep.memory.sourceLink = receivers[utilities.getRandomInt(0, receivers.length - 1)].pos;
                    }

                    assignedReceiverOperation = true;

                    const maxedWallsNearBy = Math.min(
                        ...(utilities.objToRoomPos(creep.memory.sourceLink)
                            .findInRange(FIND_STRUCTURES, 15, {filter: scan.wallFilter})
                            .map(w => w.hits))
                    ) >= utilities.desiredWallHitpoints;

                    if (maxedWallsNearBy) {
                        delete creep.memory.sourceLink;
                    } else {
                        creep.memory.noIdling = true;
                        creep.memory.staticallyAssigned = true;
                        cleanUpMemProps(creep);
                        creep.memory.taskId = taskconsts.tasks.RECEIVER_OPERATION.id;
                        continue;
                    }
                } else {
                    // no assignment possible
                    assignedReceiverOperation = true;
                }
            }

            creep.memory.noIdling = false;
            if (creep.memory.taskId != null) {
                updateAssignment(prioritizedUnitTasks, creep);
            } else {
                assignHighestPrioTask(prioritizedUnitTasks, creep);
            }
        }
    },

    executeUnitTasks: function() {
        for (const creep of Object.values(Game.creeps)) {
            if (creep.memory.taskId == -1) {
                reassign(creep);
            }

            if (creep.memory.taskId != null) {
                if (creep.memory.taskId != -1) {
                    try {
                        if (!creep.memory.safePathing) {
                            pathing.move(creep);
                        } else {
                            pathing.moveSafely(creep);
                        }
                    } catch (e) {
                        if (e instanceof MoveException) {
                            const storage = creep.room.find(FIND_MY_STRUCTURES, {filter: scan.storageFilter})[0];
                            if (!creep.memory.depositEnergy) {
                                creep.memory.depositEnergy = storage && creep.memory.type == creeps.types.WORKER && (creep.ticksToLive < 150
                                    && creep.ticksToLive < creep.pos.getRangeTo(storage)*3
                                    || creep.ticksToLive <= 10);
                            }

                            if (creep.memory.depositEnergy) {
                                if (!taskexecution.depositEnergy(creep)) creep.suicide();
                            } else {
                                taskexecution.unitTaskIdsToTaskExecutors[creep.memory.taskId](creep);
                            }
                        } else if (e instanceof MoveSafetyException) {
                            pathing.handleMoveSafetyException(creep);
                        } else {
                            throw e;
                        }
                    }
                }

            } else if (assignmentTypesToCreeptypes[taskconsts.assignmentTypes.SOLDIER].includes(parseInt(creep.memory.type))) {

                try {
                    pathing.move(creep);
                } catch (e) {
                    if (e instanceof MoveException) {
                        if (creep.ticksToLive < 1100 && utilities.calcSpawningEnergyQuotient(creep.room) > 1/3) {
                            creep.memory.renewalDirection = 'spawn';
                        } else if (creep.ticksToLive >= 1200) {
                            creep.memory.renewalDirection = 'flag';
                        }

                        if (creep.memory.renewalDirection == 'spawn' && creep.pos.findInRange(FIND_MY_SPAWNS, 1).length == 0) {
                            pathing.walkCheapestPath(creep, FIND_MY_SPAWNS, 5);
                        } else if (creep.memory.renewalDirection == 'flag') {
                            const flagFilter = flag => flag.name.endsWith('_ASA');
                            if (creep.pos.findInRange(FIND_FLAGS, 3, {filter: flagFilter}).length == 0) {
                                const flag = Game.flags[creep.room.name + '_ASA'];
                                if (flag == undefined) {
                                    const message = 'The room "' + creep.room.name
                                        + '" has no flag for the assembling of attack squads!'
                                        + ' The appropriate name would be "' + creep.room.name + '_ASA' + '".';
                                    utilities.log(message, true);
                                    continue;
                                }
                                pathing.walkCheapestPath(creep, [flag], 5);
                            }
                        }

                    } else {
                        throw e;
                    }
                }
            }
        }
    },

    executeControlTasks: function(controlTaskPrios, room) {
        if (utilities.calcAverageCpuUsage() <= 0.95) {
            executeSpawningTasks(controlTaskPrios, room);
        } else {
            utilities.log('Not spawning a new creep in room "' + room.name + '" to avoid CPU-overuse', true);
        }
    },

    unblockTasks: function(room, completeReset = false) {
        if (Memory[room.name] == undefined || Memory[room.name].taskIdsToBlockageTimes == undefined) return;
        if (completeReset) Memory[room.name].taskIdsToBlockageTimes = {};
        for (const [taskId, time] of Object.entries(Memory[room.name].taskIdsToBlockageTimes)) {
            // for entries that are meant to be permanent until the next complete reset
            if (time == -1) continue;
            if (Game.time - time > taskBlockageDuration) {
                delete Memory[room.name].taskIdsToBlockageTimes[taskId];
            }
        }
    },

    assignDefenseTask: function(room) {
        if (scan.containsEnemies(room)) {
            room.find(FIND_MY_CREEPS, {
                filter: creep => creep.memory.type == creeps.types.BRUISER
            }).forEach(creep => {
                creep.memory.taskId = taskconsts.tasks.CREEP_DEFENSE.id;
            });
        }
    },

    manipulateCreepLifetimes(room) {
        if (utilities.getFlagToScout(room) == null) return;

        const spawn = room.find(FIND_MY_SPAWNS)[0];

        const spentClaimers = spawn.pos.findInRange(FIND_MY_CREEPS, 1, {
            filter: c => scan.claimerFilter(c) && c.memory.claimedCtrl
        });

        if (spentClaimers.length > 0) {
            spawn.recycleCreep(spentClaimers[0]);
            return;
        }

        // renew SOLDIER lifetimes only if the room is trying to attack another room
        // to prevent unnecessary soldiers from accumulating in the given room
        if (utilities.calcSpawningEnergyQuotient(room) > 1/3) {
            utilities.renewCreep(room,
                creep => assignmentTypesToCreeptypes[taskconsts.assignmentTypes.SOLDIER]
                    .includes(parseInt(creep.memory.type)));
        }
    }

};


module.exports = taskhandling;
