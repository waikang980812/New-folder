"use strict";

function IdNotValidException(message) {
    this.message = message;
}


const assignmentTypes = {
    SPAWN: 0,
    CLAIMER: 1,
    SCOUT: 2,
    SOLDIER: 3,
    WORKER: 4
};

const tasks = {
    ENERGY_HARVESTING: {id: 0, assignmentType: assignmentTypes.WORKER},
    CONTROLLER_UPGRADING: {id: 1, assignmentType: assignmentTypes.WORKER},
    BRUISER_SPAWNING: {id: 2, assignmentType: assignmentTypes.SPAWN},
    TOWER_CONSTRUCTION: {id: 3, assignmentType: assignmentTypes.WORKER},
    EXTENSION_CONSTRUCTION: {id: 4, assignmentType: assignmentTypes.WORKER},
    INFLUENCE_EXPANSION: {id: 5, assignmentType: assignmentTypes.SOLDIER},
    ROAD_CONSTRUCTION: {id: 6, assignmentType: assignmentTypes.WORKER},
    WALL_CONSTRUCTION: {id: 7, assignmentType: assignmentTypes.WORKER},
    TOWER_REFUELING: {id: 8, assignmentType: assignmentTypes.WORKER},
    CLAIMER_SPAWNING: {id: 9, assignmentType: assignmentTypes.SPAWN},
    MARKSMAN_SPAWNING: {id: 10, assignmentType: assignmentTypes.SPAWN},
    MEDIC_SPAWNING: {id: 11, assignmentType: assignmentTypes.SPAWN},
    SCOUT_SPAWNING: {id: 12, assignmentType: assignmentTypes.SPAWN},
    WORKER_SPAWNING: {id: 13, assignmentType: assignmentTypes.SPAWN},
    DEMOLISHER_SPAWNING: {id: 14, assignmentType: assignmentTypes.SPAWN},
    SCOUTING: {id: 15, assignmentType: assignmentTypes.SCOUT},
    STORAGE_CONSTRUCTION: {id: 16, assignmentType: assignmentTypes.WORKER},
    ENERGY_TRANSFERRING: {id: 17, assignmentType: assignmentTypes.WORKER},
    WALL_REPAIRING: {id: 18, assignmentType: assignmentTypes.WORKER},
    CREEP_DEFENSE: {id: 19, /* assignment does not happen via prio sys */ assignmentType: null},
    BRUISER_DEFENSE_SPAWNING: {id: 20, assignmentType: assignmentTypes.SPAWN},
    LINK_CONSTRUCTION: {id: 21, assignmentType: assignmentTypes.WORKER},
    RECEIVER_OPERATION: {id: 22, assignmentType: assignmentTypes.WORKER},
    TANK_SPAWNING: {id: 23, assignmentType: assignmentTypes.SPAWN}
};


const taskconsts = {
    assignmentTypes: assignmentTypes,

    tasks: tasks,

    getTaskById: function(id) {
        const matches = Object.values(tasks).filter(task => task.id === id);
        if (matches.length != 1) throw new IdNotValidException('The given ID could not be found or is ambiguous');
        return matches[0];
    }
}


module.exports = taskconsts;
