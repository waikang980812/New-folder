"use strict";

const utilities = require('utilities');


function MissingEnergyForSpawningException(message) {
    this.message = message;
}

function CreepTypeNotValidException(message) {
    this.message = message;
}

function BodyLengthUnfitException(message) {
    this.message = message;
}


const types = {
    BRUISER: 0,
    CLAIMER: 1,
    MARKSMAN: 2,
    MEDIC: 3,
    SCOUT: 4,
    WORKER: 5,
    DEMOLISHER: 6,
    TANK: 7
};

let typesToBaseBodies = {};
typesToBaseBodies[types.BRUISER] = [MOVE, ATTACK];
typesToBaseBodies[types.CLAIMER] = [MOVE, RANGED_ATTACK, MOVE, CLAIM];
typesToBaseBodies[types.MARKSMAN] = [MOVE, RANGED_ATTACK];
typesToBaseBodies[types.MEDIC] = [MOVE, HEAL];
typesToBaseBodies[types.SCOUT] = [TOUGH, MOVE, TOUGH, MOVE, TOUGH, MOVE, TOUGH, MOVE, TOUGH, MOVE];
typesToBaseBodies[types.WORKER] = [WORK, CARRY, MOVE];
typesToBaseBodies[types.DEMOLISHER] = [MOVE, WORK];
typesToBaseBodies[types.TANK] = [TOUGH, TOUGH, MOVE];

function calculateCreepCosts(bodyPartTypes) {
    return bodyPartTypes.map(part => BODYPART_COST[part]).reduce((a, b) => a + b, 0);
}

function createMaxCreepBody(creeptype, energyAmount) {
    const baseBodyMultiplier = Math.floor(energyAmount/calculateCreepCosts(typesToBaseBodies[creeptype]));
    if (baseBodyMultiplier < 1) throw new MissingEnergyForSpawningException();

    let body = [];
    const baseBodyLength = typesToBaseBodies[creeptype].length;

    if (creeptype == types.WORKER || creeptype == types.SCOUT || creeptype == types.TANK || creeptype == types.CLAIMER) {
        if(creeptype == types.CLAIMER) console.log('Calculating CLAIMER');
        for (let i = 0; i < baseBodyMultiplier; i++) {
            if (body.length + baseBodyLength <= 50) body.push(...typesToBaseBodies[creeptype]);
        }
    } else {
        if (baseBodyLength % 2 != 0) throw new BodyLengthUnfitException();
        const valuableParts = typesToBaseBodies[creeptype].slice(baseBodyLength/2, baseBodyLength);
        const protectingParts = typesToBaseBodies[creeptype].slice(0, baseBodyLength/2);
        for (let i = 0; i < baseBodyMultiplier; i++) {
            if (body.length + baseBodyLength <= 50) {
                body.push(...valuableParts);
                body.unshift(...protectingParts);
            }
        }
    }

    return body;
}

function isValid(creeptype) {
    let result = false;
    Object.values(types).forEach(type => {
        if (type == creeptype) result = true;
    });

    return result;
}


const creeps = {
    types: types,

    // throws an exception if there is not enough energy to spawn a creep of the given type (with minimum bodyparts)
    // if no exception is thrown, a creep of maximum bodypart count is spawned (no energy is saved intentionally)
    spawnCreep: function(room, creeptype) {
        console.log('Spawn Creep function Called / Creep Type = ' + creeptype);
        if (!isValid(creeptype)) throw new CreepTypeNotValidException();

        const claimerCapReached = (room, limit) => {
            const spawn = room.find(FIND_MY_SPAWNS)[0];
            let count = 0;
            for (const name in Game.creeps) {
                if (name.startsWith(spawn.name)
                    && Game.creeps[name].memory.type == types.CLAIMER) {
                    if (++count >= limit) return true;
                }
            }

            return false;
        };

        if (creeptype == types.CLAIMER && claimerCapReached(room, 1)) {
            return;
        }

        const spawn = room.find(FIND_MY_SPAWNS)[0];
        const name = spawn.name + '_' + Game.time;
        // the API documentation states that this does not count energy saved in storage structures
        // (so only spawns and extensions are counted, as we want)
        // if we start having more than one spawn per room at some point,
        // the line below will have to be modified, if spawns can't access the energy stored in other spawns in the same room
        const energyAmount = utilities.getSpawningEnergy(spawn.room);

        spawn.spawnCreep(createMaxCreepBody(creeptype, energyAmount), name,
            {memory: {type: creeptype, taskId: creeptype == types.WORKER ? -1 : null, roomName: room.name}});
    }

};


module.exports = creeps;
module.exports.MissingEnergyForSpawningException = MissingEnergyForSpawningException;
module.exports.CreepTypeNotValidException = CreepTypeNotValidException;
