import { Request, Response, NextFunction } from 'express'
import { getRunningExpressApp } from '../utils/getRunningExpressApp'
import { Platform } from '../Interface'
import { User } from '../enterprise/database/entities/user.entity'
import { Workspace } from '../enterprise/database/entities/workspace.entity'
import { WorkspaceUser, WorkspaceUserStatus } from '../enterprise/database/entities/workspace-user.entity'
import { Organization, OrganizationName } from '../enterprise/database/entities/organization.entity'
import { OrganizationUser, OrganizationUserStatus } from '../enterprise/database/entities/organization-user.entity'
import { Role, GeneralRole } from '../enterprise/database/entities/role.entity'
import { InternalFlowiseError } from '../errors/internalFlowiseError'
import { StatusCodes } from 'http-status-codes'

export const isAuthenticated = async (req: Request, res: Response, next: NextFunction) => {
    const userEmail = req.header('X-User-Email')
    const userName = req.header('X-User-Name') || userEmail?.split('@')[0] || 'unnamed'

    if (!userEmail) {
        return res.status(401).json({ message: 'Missing user identity' })
    }

    const app = getRunningExpressApp()
    const dataSource = app.AppDataSource
    const platform = app.identityManager.getPlatformType()

    const queryRunner = dataSource.createQueryRunner()
    await queryRunner.connect()
    await queryRunner.startTransaction()

    const userRepo = queryRunner.manager.getRepository(User)
    const orgRepo = queryRunner.manager.getRepository(Organization)
    const orgUserRepo = queryRunner.manager.getRepository(OrganizationUser)
    const wsRepo = queryRunner.manager.getRepository(Workspace)
    const wsUserRepo = queryRunner.manager.getRepository(WorkspaceUser)
    const roleRepo = queryRunner.manager.getRepository(Role)

    try {
        let user = await userRepo.findOne({ where: { email: userEmail } })

        if (!user) {
            if (platform !== Platform.OPEN_SOURCE) throw new InternalFlowiseError(StatusCodes.UNAUTHORIZED, 'Only Open Source supports auto user provision')

            const orgExists = await orgRepo.count()
            if (orgExists > 0) throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'Only one organization allowed in Open Source mode')

            const ownerRole = await roleRepo.findOneByOrFail({ name: GeneralRole.OWNER })

            // create user first (needed for FK in organization.createdBy)
            user = userRepo.create({
                email: userEmail,
                name: userName,
                status: 'active',
                createdBy: 'system',
                updatedBy: 'system'
            })
            await userRepo.save(user)

            const organization = orgRepo.create({
                name: OrganizationName.DEFAULT_ORGANIZATION,
                createdBy: user.id,
                updatedBy: user.id
            })
            await orgRepo.save(organization)

            const orgUser = orgUserRepo.create({
                userId: user.id,
                organizationId: organization.id,
                roleId: ownerRole.id,
                status: OrganizationUserStatus.ACTIVE,
                createdBy: user.id,
                updatedBy: user.id
            })
            await orgUserRepo.save(orgUser)

            const workspace = wsRepo.create({
                name: 'Default Workspace',
                organizationId: organization.id,
                createdBy: user.id,
                updatedBy: user.id
            })
            await wsRepo.save(workspace)

            const wsUser = wsUserRepo.create({
                userId: user.id,
                workspaceId: workspace.id,
                roleId: ownerRole.id,
                status: WorkspaceUserStatus.ACTIVE,
                createdBy: user.id,
                updatedBy: user.id
            })
            await wsUserRepo.save(wsUser)
        }

        ;(req as any).user = user
        await queryRunner.commitTransaction()
        next()
    } catch (err) {
        await queryRunner.rollbackTransaction()
        next(err)
    } finally {
        await queryRunner.release()
    }
}